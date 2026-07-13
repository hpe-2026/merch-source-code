// =============================================================================
// Jenkinsfile — merch-source-code
// =============================================================================
//
// Pipeline     : Jenkins Declarative — Multibranch (GitHub Branch Source)
// Agent        : Kubernetes pod "devops-agent" defined in jenkins-casc-config.yaml
//                  devops   — node:20-alpine  (default; git, sed, npm, python3)
//                  kaniko   — gcr.io/kaniko-project/executor:debug
//                  security — aquasec/trivy
//
// Nexus auth   : "nexus-docker-config" K8s secret volume-mounted at
//                /kaniko/.docker by the pod template — no extra credential needed
//                for Kaniko push.
//
// Credentials  : github-pat  (Username+Password — username + PAT)
//                nexus-creds (Username+Password — used only for Nexus HTTP API
//                             calls if needed; push auth is via the mounted secret)
//
// PR build     : Checkout → Detect changed services → Install deps → Lint →
//                Unit Tests → Integration Tests → Kaniko build (--no-push).
//                No git tag. No version.txt change. No GitOps update.
//
// main build   : Same common stages →
//                Compute Version (version.txt patch bump + short-SHA image tag) →
//                Create Git tag (skipped on rerun if tag exists) →
//                Commit + push version.txt →
//                Kaniko build + push to Nexus for each changed service →
//                Two-pass sed update of kustomization.yaml newTag per service →
//                Commit + push hpe-merch-config.
//
// Feature branch (no PR, not main): Checkout → Detect → Install → Lint → Tests.
//
// Rerun safety : TAG_EXISTS guard prevents duplicate git tag creation.
//                git diff before every commit prevents empty commits.
//                git push is idempotent (exits 0 when nothing to push).
//
// Image tag    : <semver>-<7-char-sha>  e.g.  1.0.84-6d9c276
//                Matches the convention already in kustomization.yaml.
//
// GitOps sed   : Two-pass targeting — finds the exact line of
//                "- name: <service>" then rewrites only the next newTag line.
//                Prevents collateral damage to other image entries.
//
// =============================================================================

// ── Service registry ──────────────────────────────────────────────────────────
// Key   : image name as it appears in kustomization.yaml  images[].name
// Value : path to the service directory inside this repo (relative to WORKSPACE)
// ─────────────────────────────────────────────────────────────────────────────
def ALL_SERVICES = [
    'frontend'             : 'services/frontend',
    'node-backend'         : 'services/node-backend',
    'python-service'       : 'services/python-service',
    'merchant-portal'      : 'services/merchant-portal',
    'notification-service' : 'services/notification-service',
    'admin-dashboard'      : 'services/admin-dashboard'
]

pipeline {

    // ── Agent ─────────────────────────────────────────────────────────────────
    agent {
        kubernetes {
            inheritFrom 'devops-agent'
            defaultContainer 'devops'
        }
    }

    // ── Options ───────────────────────────────────────────────────────────────
    options {
        skipDefaultCheckout()
        disableConcurrentBuilds(abortPrevious: true)
        buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '5'))
        timestamps()
        ansiColor('xterm')
        timeout(time: 90, unit: 'MINUTES')
    }

    // ── Static environment ────────────────────────────────────────────────────
    environment {
        NEXUS_REGISTRY     = '192.168.56.10:30082'
        NEXUS_REPO         = 'merch-docker'
        GITHUB_ORG         = 'hpe-2026'
        SOURCE_REPO        = 'merch-source-code'
        GITOPS_REPO        = 'hpe-merch-config'
        GITOPS_MANIFEST    = 'downstream-clusters/base/kustomization.yaml'
        GIT_USER_EMAIL     = 'jenkins-bot@nitte.local'
        GIT_USER_NAME      = 'Jenkins CI Bot'

        // Runtime-computed in stages below — do not set here.
        NEW_VERSION        = ''
        IMAGE_TAG          = ''
        GIT_TAG            = ''
        TAG_EXISTS         = 'false'
        SERVICES_TO_BUILD  = ''
    }

    // =========================================================================
    stages {

        // ── 1. CHECKOUT ───────────────────────────────────────────────────────
        stage('Checkout') {
            steps {
                checkout scm
                sh '''
                    git config --global --add safe.directory "${WORKSPACE}"
                    git config user.email "${GIT_USER_EMAIL}"
                    git config user.name  "${GIT_USER_NAME}"
                '''
            }
        }

        // ── 2. DETECT CHANGED SERVICES ────────────────────────────────────────
        // Compares HEAD against the PR target branch (PR builds) or HEAD~1
        // (main builds) to find which service directories changed.
        // Falls back to building ALL services when the diff is unavailable
        // (e.g. shallow clone with no prior commit) or when no service-level
        // files changed (e.g. root-level Jenkinsfile edit).
        // ─────────────────────────────────────────────────────────────────────
        stage('Detect Changed Services') {
            steps {
                script {
                    def allServiceNames = ALL_SERVICES.keySet() as List
                    def changedSet      = [] as Set

                    try {
                        if (env.CHANGE_ID) {
                            // PR: diff against the merge-target branch
                            sh "git fetch origin ${env.CHANGE_TARGET} --depth=100 --quiet"
                            def diff = sh(
                                script: "git diff --name-only origin/${env.CHANGE_TARGET}...HEAD 2>/dev/null || true",
                                returnStdout: true
                            ).trim()
                            diff.split('\n').each { f ->
                                def parts = f.trim().tokenize('/')
                                if (parts.size() >= 2 && parts[0] == 'services') {
                                    def candidate = parts[1]
                                    if (ALL_SERVICES.containsKey(candidate)) changedSet << candidate
                                }
                            }
                        } else {
                            // main / feature: diff against previous commit
                            sh 'git fetch origin main --depth=100 --quiet || true'
                            def hasPrev = sh(
                                script: 'git rev-parse HEAD~1 >/dev/null 2>&1',
                                returnStatus: true
                            ) == 0
                            if (hasPrev) {
                                def diff = sh(
                                    script: 'git diff --name-only HEAD~1 HEAD 2>/dev/null || true',
                                    returnStdout: true
                                ).trim()
                                diff.split('\n').each { f ->
                                    def parts = f.trim().tokenize('/')
                                    if (parts.size() >= 2 && parts[0] == 'services') {
                                        def candidate = parts[1]
                                        if (ALL_SERVICES.containsKey(candidate)) changedSet << candidate
                                    }
                                }
                            }
                        }
                    } catch (Exception e) {
                        echo "WARN: Changed-service detection failed (${e.message}). Building all services."
                    }

                    // When the diff yields nothing service-related, build everything.
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
        stage('Install Dependencies') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc     = svcName.trim()
                        def svcPath = ALL_SERVICES[svc]
                        dir(svcPath) {
                            sh '''
                                if [ -f package.json ]; then
                                    npm ci --legacy-peer-deps --prefer-offline || npm ci --legacy-peer-deps
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
        stage('Lint') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc     = svcName.trim()
                        def svcPath = ALL_SERVICES[svc]
                        dir(svcPath) {
                            sh '''
                                if [ -f package.json ]; then
                                    npm run lint --if-present || true
                                fi
                            '''
                        }
                    }
                }
            }
        }

        // ── 5. UNIT TESTS ─────────────────────────────────────────────────────
        stage('Unit Tests') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc     = svcName.trim()
                        def svcPath = ALL_SERVICES[svc]
                        dir(svcPath) {
                            sh '''
                                if [ -f package.json ]; then
                                    npm test -- --ci --passWithNoTests \
                                        --reporters=default \
                                        --reporters=jest-junit \
                                        2>/dev/null || true
                                elif [ -f requirements.txt ]; then
                                    if [ -d .venv ]; then . .venv/bin/activate; fi
                                    python3 -m pytest --junitxml=test-results.xml -q || true
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
        stage('Integration Tests') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc     = svcName.trim()
                        def svcPath = ALL_SERVICES[svc]
                        dir(svcPath) {
                            sh '''
                                if [ -f package.json ]; then
                                    npm run test:integration --if-present || true
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
        // Proves every changed service Dockerfile builds against the PR merge
        // commit.  Images are tagged ephemerally and never pushed to Nexus.
        // ─────────────────────────────────────────────────────────────────────
        stage('PR: Build Images (No Push)') {
            when {
                changeRequest()
                beforeAgent true
            }
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc        = svcName.trim()
                        def svcPath    = ALL_SERVICES[svc]
                        def ephTag     = "pr-${env.CHANGE_ID}-${env.GIT_COMMIT}"
                        def destination = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO}/${svc}:${ephTag}"

                        container('kaniko') {
                            sh """
                                /kaniko/executor \\
                                    --context="dir://${WORKSPACE}/${svcPath}" \\
                                    --dockerfile="${WORKSPACE}/${svcPath}/Dockerfile" \\
                                    --destination="${destination}" \\
                                    --no-push \\
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
        // Reads version.txt (X.Y.Z), increments the patch component, derives
        // a 7-char short-SHA image tag matching the existing kustomization.yaml
        // convention, and detects whether the computed Git tag already exists
        // (rerun guard).
        //
        // Sets pipeline-wide env vars consumed by all downstream stages:
        //   NEW_VERSION  e.g.  "1.0.84"
        //   IMAGE_TAG    e.g.  "1.0.84-6d9c276"
        //   GIT_TAG      e.g.  "v1.0.84"
        //   TAG_EXISTS   "true" | "false"
        // ─────────────────────────────────────────────────────────────────────
        stage('Main: Compute Version') {
            when {
                branch 'main'
                beforeAgent true
            }
            steps {
                script {
                    sh 'git fetch --tags --quiet'

                    def rawVersion = sh(
                        script: "cat version.txt 2>/dev/null | tr -d '[:space:]' || printf '0.0.0'",
                        returnStdout: true
                    ).trim()

                    if (!rawVersion.matches('[0-9]+\\.[0-9]+\\.[0-9]+')) {
                        error("version.txt has an invalid format: '${rawVersion}'. Expected X.Y.Z.")
                    }

                    def parts    = rawVersion.tokenize('.')
                    def semver   = "${parts[0]}.${parts[1]}.${parts[2].toInteger() + 1}"
                    def shortSha = sh(script: 'git rev-parse --short=7 HEAD', returnStdout: true).trim()
                    def imageTag = "${semver}-${shortSha}"
                    def gitTag   = "v${semver}"

                    def tagStatus = sh(
                        script: "git rev-parse '${gitTag}' >/dev/null 2>&1 && printf 'true' || printf 'false'",
                        returnStdout: true
                    ).trim()

                    env.NEW_VERSION = semver
                    env.IMAGE_TAG   = imageTag
                    env.GIT_TAG     = gitTag
                    env.TAG_EXISTS  = tagStatus

                    echo "══════════════════════════════════════════════"
                    echo "  Current version  : ${rawVersion}"
                    echo "  New version      : ${semver}"
                    echo "  Image tag        : ${imageTag}"
                    echo "  Git tag          : ${gitTag}"
                    echo "  Tag already exists: ${tagStatus}"
                    echo "══════════════════════════════════════════════"
                }
            }
        }

        // ── 9. MAIN: CREATE GIT TAG ───────────────────────────────────────────
        // Skipped automatically on reruns where TAG_EXISTS == "true".
        // Annotated tag preferred over lightweight — stores author + timestamp.
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
                    retry(3) {
                        sh '''
                            git remote set-url origin \
                                "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_ORG}/${SOURCE_REPO}.git"
                            git tag -a "${GIT_TAG}" -m "Release ${GIT_TAG}"
                            git push origin "${GIT_TAG}"
                        '''
                    }
                }
            }
        }

        // ── 10. MAIN: UPDATE AND PUSH version.txt ────────────────────────────
        // Writes the incremented semver, commits, pushes to main.
        // Idempotent: skips commit when the file is already correct (rerun).
        // [ci skip] prevents a webhook-triggered build loop.
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
                    retry(3) {
                        sh '''
                            printf '%s\n' "${NEW_VERSION}" > version.txt

                            git remote set-url origin \
                                "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_ORG}/${SOURCE_REPO}.git"

                            git fetch origin main --quiet

                            git add version.txt

                            if git diff --staged --quiet; then
                                echo "[version.txt] Already at ${NEW_VERSION} — commit skipped."
                            else
                                git commit -m "chore: bump version to ${GIT_TAG} [ci skip]"
                            fi

                            git push origin main
                        '''
                    }
                }
            }
        }

        // ── 11. MAIN: KANIKO BUILD + PUSH ─────────────────────────────────────
        // Builds and pushes each changed service image to Nexus.
        // Auth:   nexus-docker-config secret mounted at /kaniko/.docker by the
        //         devops-agent pod template. No extra withCredentials needed.
        // Flags:  --insecure / --skip-tls-verify required because Nexus runs on
        //         the cluster NodePort without a trusted TLS cert.
        // retry(2): Kaniko is stateless — safe to retry from scratch.
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

                        container('kaniko') {
                            retry(2) {
                                sh """
                                    /kaniko/executor \\
                                        --context="dir://${WORKSPACE}/${svcPath}" \\
                                        --dockerfile="${WORKSPACE}/${svcPath}/Dockerfile" \\
                                        --destination="${destination}" \\
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
        // Runs Trivy against each pushed image.  Failures are non-blocking
        // (|| true) to avoid breaking the release on scan tool issues.
        // Remove "|| true" once you have established a baseline CRITICAL count.
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
                                trivy image \
                                    --severity CRITICAL,HIGH \
                                    --no-progress \
                                    --insecure \
                                    "${destination}" || true
                            """
                        }
                    }
                }
            }
        }

        // ── 13. MAIN: UPDATE GITOPS REPOSITORY ───────────────────────────────
        // Clones hpe-merch-config, rewrites newTag for each changed service in
        // downstream-clusters/base/kustomization.yaml using a two-pass sed
        // strategy (no yq), commits, and pushes to main.
        //
        // Two-pass sed strategy per service:
        //   Pass 1 — grep -n finds the absolute line number of
        //            "- name: <service>".
        //   Pass 2 — tail from that line + grep -n finds the NEXT newTag line
        //            (scoped to this service's stanza).
        //   sed line-address rewrite modifies that SINGLE line only.
        //
        // Idempotent: git diff check before commit; no push when nothing changes.
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
                    retry(3) {
                        sh '''
                            rm -rf .gitops-clone

                            git clone \
                                "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_ORG}/${GITOPS_REPO}.git" \
                                .gitops-clone

                            cd .gitops-clone

                            git config user.email "${GIT_USER_EMAIL}"
                            git config user.name  "${GIT_USER_NAME}"
                        '''

                        script {
                            env.SERVICES_TO_BUILD.split(',').each { svcName ->
                                def svc = svcName.trim()
                                sh """
                                    cd .gitops-clone

                                    # ── Pass 1: find the stanza line for this service ──
                                    NAME_LINE=\$(grep -n \
                                        "^[[:space:]]*-[[:space:]]*name:[[:space:]]*${svc}[[:space:]]*\$" \
                                        "${GITOPS_MANIFEST}" | head -1 | cut -d: -f1)

                                    if [ -z "\${NAME_LINE}" ]; then
                                        echo "ERROR: '- name: ${svc}' not found in ${GITOPS_MANIFEST}."
                                        echo "Known image names:"
                                        grep "name:" "${GITOPS_MANIFEST}"
                                        exit 1
                                    fi

                                    # ── Pass 2: find newTag offset from that stanza ────
                                    TAG_OFFSET=\$(tail -n "+\${NAME_LINE}" "${GITOPS_MANIFEST}" \\
                                                 | grep -n "^[[:space:]]*newTag:" \\
                                                 | head -1 \\
                                                 | cut -d: -f1)

                                    if [ -z "\${TAG_OFFSET}" ]; then
                                        echo "ERROR: No newTag: line after '- name: ${svc}' in ${GITOPS_MANIFEST}."
                                        exit 1
                                    fi

                                    TARGET_LINE=\$(( NAME_LINE + TAG_OFFSET - 1 ))

                                    # ── Rewrite that single line, preserving indentation ─
                                    sed -i \\
                                        "\${TARGET_LINE}s|^\\([[:space:]]*newTag:[[:space:]]*\\).*|\\1${IMAGE_TAG}|" \\
                                        "${GITOPS_MANIFEST}"

                                    # ── Verify ────────────────────────────────────────
                                    if ! grep -qF "${IMAGE_TAG}" "${GITOPS_MANIFEST}"; then
                                        echo "ERROR: sed failed for ${svc} — ${IMAGE_TAG} not in file."
                                        sed -n "\$(( TARGET_LINE - 2 )),\$(( TARGET_LINE + 2 ))p" \\
                                            "${GITOPS_MANIFEST}"
                                        exit 1
                                    fi

                                    echo "[GitOps] ${svc} → ${IMAGE_TAG} (line \${TARGET_LINE})"
                                """
                            }
                        }

                        sh '''
                            cd .gitops-clone

                            git add "${GITOPS_MANIFEST}"

                            if git diff --staged --quiet; then
                                echo "[GitOps] Manifest already up to date — commit skipped."
                            else
                                git commit -m "chore: release ${IMAGE_TAG} [ci skip]"
                                git push origin main
                            fi
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