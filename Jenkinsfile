// =============================================================================
// Jenkinsfile — merch-source-code
// =============================================================================
//
// Pipeline     : Jenkins Declarative — Multibranch (GitHub Branch Source)
// Agent        : Kubernetes pod "devops-agent" defined in jenkins-casc-config.yaml
//                  devops   — node:20-alpine  (default; git, sed, npm, python3)
//                             !! IMPORTANT: The image used for the 'devops'
//                             container MUST include git and sed.
//                             node:20-alpine does NOT ship git by default.
//                             Use a custom image:
//                               FROM node:20-alpine
//                               RUN apk add --no-cache git sed
//                             The Preflight stage will detect a missing binary
//                             and fail immediately with a clear error.
//
//                  kaniko   — gcr.io/kaniko-project/executor:debug
//                             !! CRITICAL: The kaniko executor container exits
//                             after every single build (PID 1 dies when the
//                             executor finishes). Each service build MUST be
//                             wrapped in its own container('kaniko') { } block
//                             so Jenkins re-attaches to a fresh kaniko process
//                             for every subsequent build.  Sharing one
//                             container() block across multiple sh calls causes
//                             "Process exited immediately after creation" on
//                             the second service.
//
//                  security — aquasec/trivy
//
// Nexus auth   : "nexus-docker-config" K8s secret volume-mounted at
//                /kaniko/.docker by the pod template.
//
// Credentials  : github-pat  (Username+Password — configured in Jenkins)
//
// PR build     : Preflight → Checkout → Detect → Install → Lint →
//                Unit Tests → Integration Tests → Kaniko build (--no-push).
//
// main build   : Same common stages →
//                Compute Version → Create Git tag (auto, skipped on rerun) →
//                Update version.txt → Kaniko build + push →
//                Security scan → Update GitOps repo.
//
// Image tag    : <semver>-<7-char-sha>  e.g.  1.0.84-b538e15
//                Same tag used in Nexus image AND written to kustomization.yaml.
//
// Git tag      : v<semver>  e.g.  v1.0.84
//                Created automatically on main. Never create manually.
//
// Kaniko fix   : Each service is built inside its own container('kaniko') block.
//                This is the correct pattern — kaniko executor exits after one
//                run; Jenkins must re-attach per build.
//
// Retry scope  : retry() wraps ONLY network I/O: git fetch, git clone,
//                git push, Kaniko push. Never wraps logic.
//
// Global build : Changes to shared/, common/, libs/, Dockerfile.base,
//                package-lock.json, or package.json trigger full rebuild.
//
// =============================================================================

def ALL_SERVICES = [
    'frontend'             : 'services/frontend',
    'node-backend'         : 'services/node-backend',
    'python-service'       : 'services/python-service',
    'merchant-portal'      : 'services/merchant-portal',
    'notification-service' : 'services/notification-service',
    'admin-dashboard'      : 'services/admin-dashboard'
]

def GLOBAL_TRIGGER_DIRS  = ['shared/', 'common/', 'libs/']
def GLOBAL_TRIGGER_FILES = ['Dockerfile.base', 'package-lock.json', 'package.json']

pipeline {

    agent {
        kubernetes {
            inheritFrom 'devops-agent'
            defaultContainer 'devops'
            yamlMergeStrategy merge()
            yaml '''
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: devops
    command:
    - sh
    - "-c"
    args:
    - "set -e && apk add --no-cache git bash openssh-client sed && sleep 99d"
'''
        }
    }

    options {
        skipDefaultCheckout()
        disableConcurrentBuilds(abortPrevious: true)
        buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '5'))
        timestamps()
        ansiColor('xterm')
        timeout(time: 90, unit: 'MINUTES')
    }

    environment {
        NEXUS_REGISTRY    = '192.168.56.10:30082'
        NEXUS_REPO        = 'merch-docker'
        GITHUB_ORG        = 'hpe-2026'
        SOURCE_REPO       = 'merch-source-code'
        GITOPS_REPO       = 'hpe-merch-config'
        GITOPS_MANIFEST   = 'downstream-clusters/base/kustomization.yaml'
        GIT_USER_EMAIL    = 'jenkins-bot@nitte.local'
        GIT_USER_NAME     = 'Jenkins CI Bot'

        NEW_VERSION       = ''
        IMAGE_TAG         = ''
        GIT_TAG           = ''
        TAG_EXISTS        = 'false'
        SERVICES_TO_BUILD = ''
    }

    // =========================================================================
    stages {

        // ── 0. PREFLIGHT ──────────────────────────────────────────────────────
        // Verify required binaries exist in the devops container before any
        // real work begins. Fails fast with a human-readable message.
        // node:20-alpine does NOT include git — use a custom image that does.
        // ─────────────────────────────────────────────────────────────────────
        stage('Preflight: Verify Tools') {
            steps {
                sh '''
                    set -euo pipefail
                    echo "=== Preflight: checking required binaries ==="

                    if ! command -v git >/dev/null 2>&1; then
                        echo "FATAL: git is not available in this container."
                        echo "The devops container image must include git."
                        echo "node:20-alpine does NOT ship git by default."
                        echo "Fix: FROM node:20-alpine && RUN apk add --no-cache git sed"
                        exit 1
                    fi

                    if ! command -v sed >/dev/null 2>&1; then
                        echo "FATAL: sed is not available in this container."
                        exit 1
                    fi

                    echo "git  : $(git --version)"
                    echo "sed  : $(sed --version 2>&1 | head -1)"
                    echo "node : $(node --version)"
                    echo "npm  : $(npm --version)"
                    echo "=== Preflight passed ==="
                '''
            }
        }

        // ── 1. CHECKOUT ───────────────────────────────────────────────────────
        stage('Checkout') {
            steps {
                checkout scm
                sh '''
                    set -euo pipefail
                    git config --global --add safe.directory "${WORKSPACE}"
                    git config user.email "${GIT_USER_EMAIL}"
                    git config user.name  "${GIT_USER_NAME}"
                '''
            }
        }

        // ── 2. DETECT CHANGED SERVICES ────────────────────────────────────────
        // Diffs against PR target (PR builds) or HEAD~1 (main/feature).
        // Global trigger: if shared infrastructure files change, build ALL.
        // Falls back to ALL when diff is unavailable.
        // ─────────────────────────────────────────────────────────────────────
        stage('Detect Changed Services') {
            steps {
                script {
                    def allServiceNames = ALL_SERVICES.keySet() as List
                    def changedSet      = [] as Set
                    def diffLines       = []

                    try {
                        if (env.CHANGE_ID) {
                            retry(3) {
                                sh "git fetch origin \"${env.CHANGE_TARGET}\" --depth=100 --quiet"
                            }
                            def diff = sh(
                                script: "git diff --name-only \"origin/${env.CHANGE_TARGET}...HEAD\" 2>/dev/null || true",
                                returnStdout: true
                            ).trim()
                            if (diff) diffLines = diff.split('\n').collect { it.trim() }
                        } else {
                            retry(3) {
                                sh 'git fetch origin main --depth=100 --quiet || true'
                            }
                            def hasPrev = sh(
                                script: 'git rev-parse HEAD~1 >/dev/null 2>&1',
                                returnStatus: true
                            ) == 0
                            if (hasPrev) {
                                def diff = sh(
                                    script: 'git diff --name-only HEAD~1 HEAD 2>/dev/null || true',
                                    returnStdout: true
                                ).trim()
                                if (diff) diffLines = diff.split('\n').collect { it.trim() }
                            }
                        }
                    } catch (Exception e) {
                        echo "WARN: Changed-service detection failed (${e.message}). Building all services."
                        diffLines = []
                    }

                    // Global trigger: shared infra change → rebuild everything
                    def globalTriggerHit = diffLines.any { filePath ->
                        GLOBAL_TRIGGER_DIRS.any  { dir  -> filePath.startsWith(dir) } ||
                        GLOBAL_TRIGGER_FILES.any  { name -> filePath == name }
                    }

                    if (globalTriggerHit) {
                        changedSet = allServiceNames as Set
                        echo "Global trigger path detected — rebuilding ALL services."
                    } else {
                        diffLines.each { f ->
                            def parts = f.tokenize('/')
                            if (parts.size() >= 2 && parts[0] == 'services') {
                                def candidate = parts[1]
                                if (ALL_SERVICES.containsKey(candidate)) {
                                    changedSet << candidate
                                }
                            }
                        }
                    }

                    if (changedSet.isEmpty()) {
                        changedSet = allServiceNames as Set
                        echo "No service-specific changes detected — building ALL services."
                    } else {
                        echo "Services to build: ${changedSet.join(', ')}"
                    }

                    env.SERVICES_TO_BUILD = changedSet.join(',')
                }
            }
        }

        // ── 3. INSTALL DEPENDENCIES ───────────────────────────────────────────
        // npm ci for Node services, pip install for Python services.
        // No npm audit here — auditing is a separate concern from installation.
        // ─────────────────────────────────────────────────────────────────────
        stage('Install Dependencies') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc     = svcName.trim()
                        def svcPath = ALL_SERVICES[svc]
                        dir(svcPath) {
                            sh '''
                                set -euo pipefail
                                if [ -f package.json ]; then
                                    npm ci --legacy-peer-deps --prefer-offline \
                                        || npm ci --legacy-peer-deps
                                elif [ -f requirements.txt ]; then
                                    python3 -m venv .venv
                                    . .venv/bin/activate
                                    pip install --quiet -r requirements.txt
                                fi
                            '''
                        }
                    }
                }
            }
        }

        // ── 4. LINT ───────────────────────────────────────────────────────────
        // --if-present: services without a lint script are skipped gracefully.
        // No || true: a non-zero exit from an existing lint script fails the
        // build. PRs must not merge with lint errors.
        // ─────────────────────────────────────────────────────────────────────
        stage('Lint') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc     = svcName.trim()
                        def svcPath = ALL_SERVICES[svc]
                        dir(svcPath) {
                            sh '''
                                set -euo pipefail
                                if [ -f package.json ]; then
                                    npm run lint --if-present
                                fi
                            '''
                        }
                    }
                }
            }
        }

        // ── 5. UNIT TESTS ─────────────────────────────────────────────────────
        // No || true: test failures fail the build.
        // allowEmptyResults kept on junit: a service may have no tests yet.
        // ─────────────────────────────────────────────────────────────────────
        stage('Unit Tests') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc     = svcName.trim()
                        def svcPath = ALL_SERVICES[svc]
                        dir(svcPath) {
                            sh '''
                                set -euo pipefail
                                if [ -f package.json ]; then
                                    npm test -- --ci --passWithNoTests \
                                        --reporters=default \
                                        --reporters=jest-junit
                                elif [ -f requirements.txt ]; then
                                    if [ -d .venv ]; then . .venv/bin/activate; fi
                                    python3 -m pytest --junitxml=test-results.xml -q
                                fi
                            '''
                        }
                    }
                }
            }
            post {
                always {
                    junit allowEmptyResults: true,
                          testResults: '**/test-results.xml,**/junit.xml'
                }
            }
        }

        // ── 6. INTEGRATION TESTS ──────────────────────────────────────────────
        // No || true: failures fail the build.
        // --if-present: services without the script are skipped.
        // ─────────────────────────────────────────────────────────────────────
        stage('Integration Tests') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc     = svcName.trim()
                        def svcPath = ALL_SERVICES[svc]
                        dir(svcPath) {
                            sh '''
                                set -euo pipefail
                                if [ -f package.json ]; then
                                    npm run test:integration --if-present
                                fi
                            '''
                        }
                    }
                }
            }
        }

        // =====================================================================
        // PR-ONLY STAGE
        // =====================================================================

        // ── 7. PR: KANIKO BUILD (NO PUSH) ─────────────────────────────────────
        // CRITICAL FIX: Each service gets its own container('kaniko') block.
        // The kaniko executor container exits (PID 1 dies) after every single
        // build. Wrapping multiple sh calls inside one container() block causes
        // "Process exited immediately after creation" on the second call.
        // Iterating and opening a fresh container() per service is the correct
        // pattern — Jenkins re-attaches to the restarted kaniko process each time.
        // ─────────────────────────────────────────────────────────────────────
        stage('PR: Build Images (No Push)') {
            when {
                changeRequest()
                beforeAgent true
            }
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc         = svcName.trim()
                        def svcPath     = ALL_SERVICES[svc]
                        def ephTag      = "pr-${env.CHANGE_ID}-${env.GIT_COMMIT?.take(7) ?: 'unknown'}"
                        def destination = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO}/${svc}:${ephTag}"
                        def cacheRepo   = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO}/cache"

                        echo "Building (no-push) ${svc} → ${destination}"

                        // Each service gets a fresh container() attachment.
                        // Do NOT move this outside the loop.
                        container('kaniko') {
                            sh """
                                /kaniko/executor \\
                                    --context="dir://${WORKSPACE}/${svcPath}" \\
                                    --dockerfile="${WORKSPACE}/${svcPath}/Dockerfile" \\
                                    --destination="${destination}" \\
                                    --no-push \\
                                    --cache=true \\
                                    --cache-repo="${cacheRepo}" \\
                                    --cache-ttl=168h \\
                                    --insecure \\
                                    --insecure-pull \\
                                    --skip-tls-verify \\
                                    --log-format=text \\
                                    --verbosity=warn \\
                                    --cleanup
                            """
                        }
                    }
                }
            }
        }

        // =====================================================================
        // MAIN BRANCH-ONLY STAGES
        // =====================================================================

        // ── 8. MAIN: COMPUTE VERSION ──────────────────────────────────────────
        // Reads version.txt (X.Y.Z), increments patch, derives IMAGE_TAG as
        // <semver>-<7charSHA>.  This same tag is used for the Nexus image push
        // AND written into kustomization.yaml — one tag, consistent everywhere.
        //
        // TAG_EXISTS uses git ls-remote --tags origin (remote-safe).
        // git rev-parse only checks local refs and fails on fresh workspaces.
        // ─────────────────────────────────────────────────────────────────────
        stage('Main: Compute Version') {
            when {
                branch 'main'
                beforeAgent true
            }
            steps {
                withCredentials([
                    usernamePassword(
                        credentialsId: 'github-pat',
                        usernameVariable: 'GITHUB_USER',
                        passwordVariable: 'GITHUB_TOKEN'
                    )
                ]) {
                    script {
                        retry(3) {
                            sh '''
                                set -euo pipefail
                                git remote set-url origin \
                                    "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_ORG}/${SOURCE_REPO}.git"
                                git fetch --tags --quiet
                            '''
                        }

                        def rawVersion = sh(
                            script: "cat version.txt 2>/dev/null | tr -d '[:space:]' || printf '0.0.0'",
                            returnStdout: true
                        ).trim()

                        if (!rawVersion.matches('[0-9]+\\.[0-9]+\\.[0-9]+')) {
                            error("version.txt has invalid format: '${rawVersion}'. Expected X.Y.Z.")
                        }

                        def parts    = rawVersion.tokenize('.')
                        def semver   = "${parts[0]}.${parts[1]}.${parts[2].toInteger() + 1}"
                        def shortSha = sh(
                            script: 'git rev-parse --short=7 HEAD',
                            returnStdout: true
                        ).trim()
                        def imageTag = "${semver}-${shortSha}"
                        def gitTag   = "v${semver}"

                        // Remote-safe tag check — works on fresh workspaces
                        // and shallow clones where local tag refs may be absent.
                        def tagStatus = sh(
                            script: """
                                set -euo pipefail
                                git ls-remote --tags origin "refs/tags/${gitTag}" \
                                    | grep -q . && printf 'true' || printf 'false'
                            """,
                            returnStdout: true
                        ).trim()

                        env.NEW_VERSION = semver
                        env.IMAGE_TAG   = imageTag
                        env.GIT_TAG     = gitTag
                        env.TAG_EXISTS  = tagStatus

                        echo "══════════════════════════════════════════════"
                        echo "  Current version    : ${rawVersion}"
                        echo "  New version        : ${semver}"
                        echo "  Nexus image tag    : ${imageTag}"
                        echo "  Git tag (auto)     : ${gitTag}"
                        echo "  Tag already exists : ${tagStatus}"
                        echo "══════════════════════════════════════════════"
                    }
                }
            }
        }

        // ── 9. MAIN: CREATE GIT TAG ───────────────────────────────────────────
        // Tags are created AUTOMATICALLY by this stage on every successful
        // main build.  Do NOT create version tags manually in GitHub.
        // Skipped when TAG_EXISTS == "true" (rerun safety).
        // Annotated tag stores author + timestamp for audit trail.
        // Only the git push is retried (network I/O).
        // ─────────────────────────────────────────────────────────────────────
        stage('Main: Create Git Tag') {
            when {
                allOf {
                    branch 'main'
                    expression { return env.TAG_EXISTS == 'false' }
                }
                beforeAgent true
            }
            steps {
                withCredentials([
                    usernamePassword(
                        credentialsId: 'github-pat',
                        usernameVariable: 'GITHUB_USER',
                        passwordVariable: 'GITHUB_TOKEN'
                    )
                ]) {
                    sh '''
                        set -euo pipefail
                        git remote set-url origin \
                            "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_ORG}/${SOURCE_REPO}.git"
                        git tag -a "${GIT_TAG}" -m "Release ${GIT_TAG} — built by Jenkins #${BUILD_NUMBER}"
                    '''
                    retry(3) {
                        sh '''
                            set -euo pipefail
                            git push origin "${GIT_TAG}"
                        '''
                    }
                    echo "✅ Git tag ${env.GIT_TAG} pushed to ${env.GITHUB_ORG}/${env.SOURCE_REPO}"
                }
            }
        }

        // ── 10. MAIN: UPDATE version.txt ──────────────────────────────────────
        // Writes incremented semver, commits with [ci skip], pushes to main.
        // Idempotent: skips commit if file already matches (rerun safety).
        // [ci skip] prevents a webhook-triggered build loop.
        // Only git fetch and git push are retried.
        // ─────────────────────────────────────────────────────────────────────
        stage('Main: Update version.txt') {
            when {
                branch 'main'
                beforeAgent true
            }
            steps {
                withCredentials([
                    usernamePassword(
                        credentialsId: 'github-pat',
                        usernameVariable: 'GITHUB_USER',
                        passwordVariable: 'GITHUB_TOKEN'
                    )
                ]) {
                    sh '''
                        set -euo pipefail
                        git remote set-url origin \
                            "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_ORG}/${SOURCE_REPO}.git"
                        printf '%s\n' "${NEW_VERSION}" > version.txt
                        git add version.txt
                    '''
                    retry(3) {
                        sh 'set -euo pipefail && git fetch origin main --quiet'
                    }
                    sh '''
                        set -euo pipefail
                        if git diff --staged --quiet; then
                            echo "[version.txt] Already at ${NEW_VERSION} — commit skipped."
                        else
                            git commit -m "chore: bump version to ${GIT_TAG} [ci skip]"
                        fi
                    '''
                    retry(3) {
                        sh 'set -euo pipefail && git push origin main'
                    }
                }
            }
        }

        // ── 11. MAIN: KANIKO BUILD + PUSH ─────────────────────────────────────
        // CRITICAL FIX: Each service gets its own container('kaniko') block.
        //
        // WHY: The kaniko executor (gcr.io/kaniko-project/executor:debug) exits
        // after completing one build — its PID 1 process terminates. When
        // Jenkins tries to exec into the container for the next service, the
        // container is dead and emits "Process exited immediately after creation".
        //
        // CORRECT PATTERN: Open container('kaniko') per service inside the loop.
        // Jenkins will re-attach to the pod's kaniko container after it restarts
        // (the pod stays alive; only the executor process inside it exits).
        //
        // Image tag: <semver>-<7charSHA>  — same tag used in kustomization.yaml.
        // Cache: layers stored in Nexus cache repo, 7-day TTL.
        // Auth: via nexus-docker-config secret mounted at /kaniko/.docker.
        // retry(2) on the executor call (network push).
        // ─────────────────────────────────────────────────────────────────────
        stage('Main: Build and Push Images') {
            when {
                branch 'main'
                beforeAgent true
            }
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc         = svcName.trim()
                        def svcPath     = ALL_SERVICES[svc]
                        def destination = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO}/${svc}:${env.IMAGE_TAG}"
                        def cacheRepo   = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO}/cache"

                        echo "Building and pushing ${svc} → ${destination}"

                        // Each service MUST have its own container() block.
                        // Do NOT hoist container('kaniko') outside this loop.
                        container('kaniko') {
                            retry(2) {
                                sh """
                                    /kaniko/executor \\
                                        --context="dir://${WORKSPACE}/${svcPath}" \\
                                        --dockerfile="${WORKSPACE}/${svcPath}/Dockerfile" \\
                                        --destination="${destination}" \\
                                        --cache=true \\
                                        --cache-repo="${cacheRepo}" \\
                                        --cache-ttl=168h \\
                                        --insecure \\
                                        --insecure-pull \\
                                        --skip-tls-verify \\
                                        --log-format=text \\
                                        --verbosity=warn \\
                                        --cleanup
                                """
                            }
                        }
                    }
                }
            }
        }

        // ── 12. MAIN: SECURITY SCAN ───────────────────────────────────────────
        // Trivy scans each pushed image for CRITICAL and HIGH CVEs.
        // Non-blocking (|| true) until a CVE baseline is established.
        // Remove || true once baseline is set and enforce with --exit-code 1.
        // ─────────────────────────────────────────────────────────────────────
        stage('Main: Security Scan') {
            when {
                branch 'main'
                beforeAgent true
            }
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc         = svcName.trim()
                        def destination = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO}/${svc}:${env.IMAGE_TAG}"

                        container('security') {
                            sh """
                                trivy image \\
                                    --severity CRITICAL,HIGH \\
                                    --no-progress \\
                                    --insecure \\
                                    "${destination}" || true
                            """
                        }
                    }
                }
            }
        }

        // ── 13. MAIN: UPDATE GITOPS REPOSITORY ───────────────────────────────
        // Clones hpe-merch-config, rewrites newTag for each changed service in
        // kustomization.yaml using two-pass sed (no yq dependency).
        //
        // The IMAGE_TAG written here is identical to the Nexus push tag above.
        // One tag — consistent across Git, Nexus, and GitOps manifest.
        //
        // Idempotent: git diff check before commit; no push when up-to-date.
        // Only git clone and git push are retried.
        // ─────────────────────────────────────────────────────────────────────
        stage('Main: Update GitOps Repository') {
            when {
                branch 'main'
                beforeAgent true
            }
            steps {
                withCredentials([
                    usernamePassword(
                        credentialsId: 'github-pat',
                        usernameVariable: 'GITHUB_USER',
                        passwordVariable: 'GITHUB_TOKEN'
                    )
                ]) {
                    sh 'set -euo pipefail && rm -rf .gitops-clone'

                    retry(3) {
                        sh '''
                            set -euo pipefail
                            git clone \
                                "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_ORG}/${GITOPS_REPO}.git" \
                                .gitops-clone
                        '''
                    }

                    sh '''
                        set -euo pipefail
                        cd .gitops-clone
                        git config user.email "${GIT_USER_EMAIL}"
                        git config user.name  "${GIT_USER_NAME}"
                    '''

                    script {
                        env.SERVICES_TO_BUILD.split(',').each { svcName ->
                            def svc = svcName.trim()
                            sh """
                                set -euo pipefail
                                cd .gitops-clone

                                # Pass 1: find the stanza line for this service
                                NAME_LINE=\$(grep -n \
                                    "^[[:space:]]*-[[:space:]]*name:[[:space:]]*${svc}[[:space:]]*\$" \
                                    "${GITOPS_MANIFEST}" | head -1 | cut -d: -f1)

                                if [ -z "\${NAME_LINE}" ]; then
                                    echo "ERROR: '- name: ${svc}' not found in ${GITOPS_MANIFEST}."
                                    grep "name:" "${GITOPS_MANIFEST}"
                                    exit 1
                                fi

                                # Pass 2: find the next newTag line after this stanza
                                TAG_OFFSET=\$(tail -n "+\${NAME_LINE}" "${GITOPS_MANIFEST}" \\
                                             | grep -n "^[[:space:]]*newTag:" \\
                                             | head -1 \\
                                             | cut -d: -f1)

                                if [ -z "\${TAG_OFFSET}" ]; then
                                    echo "ERROR: No newTag: line after '- name: ${svc}'."
                                    exit 1
                                fi

                                TARGET_LINE=\$(( NAME_LINE + TAG_OFFSET - 1 ))

                                # Rewrite that single line, preserving indentation
                                sed -i \\
                                    "\${TARGET_LINE}s|^\\([[:space:]]*newTag:[[:space:]]*\\).*|\\1${IMAGE_TAG}|" \\
                                    "${GITOPS_MANIFEST}"

                                # Verify the rewrite succeeded
                                if ! grep -qF "${IMAGE_TAG}" "${GITOPS_MANIFEST}"; then
                                    echo "ERROR: sed rewrite failed for ${svc}."
                                    sed -n "\$(( TARGET_LINE - 2 )),\$(( TARGET_LINE + 2 ))p" \
                                        "${GITOPS_MANIFEST}"
                                    exit 1
                                fi

                                echo "[GitOps] ${svc} → ${IMAGE_TAG} (line \${TARGET_LINE})"
                            """
                        }
                    }

                    sh '''
                        set -euo pipefail
                        cd .gitops-clone
                        git add "${GITOPS_MANIFEST}"
                        if git diff --staged --quiet; then
                            echo "[GitOps] Manifest already up to date — commit skipped."
                        else
                            git commit -m "chore: release ${IMAGE_TAG} [ci skip]"
                        fi
                    '''

                    retry(3) {
                        sh '''
                            set -euo pipefail
                            cd .gitops-clone
                            git push origin main
                        '''
                    }
                }
            }
        }

    } // end stages

    // =========================================================================
    post {

        success {
            echo "✅  Pipeline SUCCEEDED — ${BRANCH_NAME} — build #${BUILD_NUMBER}"
            echo "    Image tag : ${IMAGE_TAG ?: 'N/A (PR or feature build)'}"
            echo "    Git tag   : ${GIT_TAG   ?: 'N/A (PR or feature build)'}"
        }

        failure {
            echo "❌  Pipeline FAILED — ${BRANCH_NAME} — build #${BUILD_NUMBER}"
            echo "    Review the stage logs above for the root cause."
        }

        cleanup {
            cleanWs(
                cleanWhenSuccess: true,
                cleanWhenFailure: true,
                cleanWhenAborted: true,
                notFailBuild:     true
            )
        }

    }
}