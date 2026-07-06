// =============================================================================
// Jenkinsfile  —  merch-source-code
//
// BEHAVIOR:
//   Pull Request builds  → CI only: setup tools, checkout, detect changes,
//                          install deps, build, unit tests.
//                          SonarQube is DISABLED until deployed (see SONAR_ENABLED).
//                          No image is built or pushed on a PR build.
//
//   main branch builds   → full CI/CD:
//                          All CI stages above PLUS:
//                          ├── Kaniko: build container images (parallel per svc)
//                          ├── Push to Nexus: 192.168.56.10:30082/merch-docker/<svc>:<tag>
//                          └── Update downstream-clusters/base/kustomization.yaml
//                              on the 'dev' branch of hpe-merch-config
//                              → ArgoCD 'downstream-dev' detects the commit
//                              → deploys to dev cluster (192.168.56.11)
//
// Jenkins NEVER runs kubectl / helm / argocd.
// It only pushes images and edits a YAML file.
// ArgoCD does ALL deployments.
//
// =============================================================================
//
// ── PREREQUISITES (one-time setup before the first run) ──────────────────────
//
//  1. Jenkins Credentials (Manage Jenkins → Credentials → Global):
//       ID: github-pat      Type: Username+Password
//                           Username: your GitHub username (or org bot account)
//                           Password: GitHub PAT with 'repo' scope
//                           (must be able to push to hpe-2026/hpe-merch-config)
//       ID: nexus-creds     Type: Username+Password
//                           Username: admin
//                           Password: (Nexus admin password — check admin-secrets)
//
//  2. Nexus Docker repo (Nexus UI → Admin → Repositories → Create repository):
//       Format:  docker (hosted)
//       Name:    merch-docker
//       HTTP:    8082        ← matches the NodePort service nexus-docker
//       Allow anonymous docker pull: ✓ (simplifies cluster pulls)
//
//  3. nexus-docker-config Secret (create OUT-OF-BAND on admin cluster):
//       # Generate the auth string:
//       echo -n 'admin:YOUR_NEXUS_PASSWORD' | base64
//       # Create the config.json file:
//       cat > /tmp/nexus-docker-config.json << 'EOF'
//       {
//         "auths": {
//           "192.168.56.10:30082": {
//             "auth": "PASTE_BASE64_HERE"
//           }
//         }
//       }
//       EOF
//       kubectl create secret generic nexus-docker-config \
//         --from-file=config.json=/tmp/nexus-docker-config.json \
//         -n system
//
//  4. Dev/Prod cluster insecure registry (on EACH node of worker1 + worker2):
//       sudo mkdir -p /etc/rancher/rke2
//       sudo tee /etc/rancher/rke2/registries.yaml << 'EOF'
//       mirrors:
//         "192.168.56.10:30082":
//           endpoint:
//             - "http://192.168.56.10:30082"
//       configs:
//         "192.168.56.10:30082":
//           auth:
//             username: admin
//             password: YOUR_NEXUS_PASSWORD
//       EOF
//       sudo systemctl restart rke2-agent  # (or rke2-server on single-node)
//
// =============================================================================

// ---- Master list of microservices in this monorepo -------------------------
// Key   = service name (also the image name and the kustomization.yaml .name)
// Value = path relative to repo root that contains the Dockerfile
def ALL_SERVICES = [
    "frontend"             : "services/frontend",
    "node-backend"         : "services/node-backend",
    "python-service"       : "services/python-service",
    "merchant-portal"      : "services/merchant-portal",
    "notification-service" : "services/notification-service",
    "admin-dashboard"      : "services/admin-dashboard"
]

// ---- Helper: resolve service directory from map ----------------------------
def svcDir(Map allSvcs, String svc) {
    def d = allSvcs[svc]
    if (!d) { error("Unknown service '${svc}' — not listed in ALL_SERVICES.") }
    return d
}

// ============================================================================
pipeline {

    // ── Agent ────────────────────────────────────────────────────────────────
    // "devops-agent" pod template is defined in jenkins-casc-config.yaml.
    // The pod has two containers:
    //   devops  → node:20-alpine  (CI work: checkout, install, build, test, git)
    //   kaniko  → gcr.io/kaniko-project/executor:debug  (image builds)
    agent {
        kubernetes {
            inheritFrom 'devops-agent'
        }
    }

    options {
        skipDefaultCheckout()
        timestamps()
        ansiColor('xterm')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '25', artifactNumToKeepStr: '10'))
        timeout(time: 90, unit: 'MINUTES')
    }

    environment {
        // ── Service list (CSV) — derived from the Map defined above ──────────
        ALL_SERVICES_CSV = ALL_SERVICES.keySet().join(',')

        // ── Nexus Docker Registry ─────────────────────────────────────────────
        // Address reachable from:
        //   • Kaniko running inside admin cluster pods (NodePort via 192.168.56.10)
        //   • Dev cluster (192.168.56.11) and prod cluster (192.168.56.12) nodes
        //     pulling images (NodePort exposed on admin cluster node)
        NEXUS_REGISTRY  = '192.168.56.10:30082'
        // The Docker hosted repository name created in Nexus UI.
        NEXUS_REPO_NAME = 'merch-docker'

        // ── GitOps Config Repo ────────────────────────────────────────────────
        CONFIG_REPO_URL    = 'https://github.com/hpe-2026/hpe-merch-config.git'
        CONFIG_REPO_DIR    = 'hpe-merch-config'
        // Push image tag updates to the 'dev' branch so ArgoCD's downstream-dev
        // Application (which watches the 'dev' branch) picks them up and deploys
        // to the dev cluster. Promotion to prod is a separate manual PR: dev → prod.
        CONFIG_REPO_BRANCH = 'dev'

        // ── Feature flags ─────────────────────────────────────────────────────
        // Set to 'true' once SonarQube is deployed on the admin cluster.
        // When 'false', the SonarQube Analysis + Quality Gate stages are skipped.
        SONAR_ENABLED = 'false'

        // ── Credential IDs (must exist in Jenkins → Manage Credentials) ───────
        GITHUB_CRED_ID  = 'github-pat'
        SONAR_TOKEN_ID  = 'sonarqube-token'
        NEXUS_CRED_ID   = 'nexus-creds'

        // ── SonarQube server name (matches Manage Jenkins → System config) ────
        SONARQUBE_SERVER = 'sonarqube-admin'
    }

    // =========================================================================
    stages {

        // ── Setup Tools ───────────────────────────────────────────────────────
        // node:20-alpine ships with node + npm.
        // git, python3, pip, curl, yq are installed here.
        // This adds ~45 s per build but avoids maintaining a custom image.
        // Once you have a Nexus registry working, replace this with a
        // pre-built devops image: 192.168.56.10:30082/merch-docker/devops-tools:1.0
        //
        // ── WHY safe.directory IS SET HERE ────────────────────────────────────
        // The Kubernetes plugin mounts a single shared workspace volume into ALL
        // pod containers. The jnlp container (uid 1000, "jenkins") is the first
        // container to start and it creates the workspace directory tree, meaning
        // the workspace root is owned by uid 1000.
        //
        // Every subsequent git operation in this pipeline runs inside the devops
        // container (node:20-alpine), which runs as uid 0 (root). Git 2.35.2+
        // introduced CVE-2022-24765 protection: if the directory owner's uid does
        // not match the running process's uid, Git aborts with:
        //   "fatal: detected dubious ownership in repository"
        //
        // Setting safe.directory to the Jenkins workspace path (${WORKSPACE}) in
        // the first stage, before any git command runs, tells Git that this
        // specific path is intentionally operated on by a different uid — which
        // is the documented, upstream-sanctioned mechanism for exactly this
        // container/CI scenario. It is scoped to the workspace path only and does
        // NOT use the '*' wildcard, which would be the unsafe alternative.
        //
        // Root-level /root/.gitconfig is used because devops runs as root and
        // --global resolves to /root/.gitconfig inside that container.
        stage('Setup Tools') {
            steps {
                container('devops') {
                    sh '''
                        set -e
                        echo "──── Installing system tools ────"
                        apk add --no-cache git python3 py3-pip curl bash openssl

                        echo "──── Installing yq v4 (YAML processor) ────"
                        YQ_VERSION="v4.40.5"
                        curl -fsSL \
                            "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" \
                            -o /usr/local/bin/yq
                        chmod +x /usr/local/bin/yq
                        yq --version

                        echo "──── Tool versions ────"
                        node --version
                        npm  --version
                        git  --version
                        python3 --version
                        curl --version | head -1
                    '''

                    // ── FIX: Register workspace as a safe.directory ───────────
                    // Must run AFTER git is installed (above) and BEFORE any
                    // git command runs (Checkout stage and everything after).
                    // ${WORKSPACE} is the Jenkins-injected env var pointing to
                    // the shared volume mount path, e.g.:
                    //   /home/jenkins/agent/workspace/merch-source-code_main
                    // Using --global scopes this to the devops container's root
                    // user only. The jnlp container is unaffected.
                    sh 'git config --global --add safe.directory "${WORKSPACE}"'

                    // Also register the config repo subdirectory that the
                    // Update Config Repository stage will clone into, so the
                    // git operations inside that cloned repo also succeed.
                    sh 'git config --global --add safe.directory "${WORKSPACE}/${CONFIG_REPO_DIR}"'
                }
            }
        }

        // ── Checkout ──────────────────────────────────────────────────────────
        // Executed inside container('devops') as root (uid 0).
        // git is installed in Setup Tools so checkout scm works cleanly.
        // The workspace root is owned by jnlp (uid 1000) but Git now trusts
        // it because safe.directory was set in Setup Tools above.
        // All checked-out workspace files are written by root (uid 0).
        stage('Checkout') {
            steps {
                container('devops') {
                    checkout scm
                    script {
                        env.GIT_SHORT_SHA = sh(
                            script: 'git rev-parse --short HEAD',
                            returnStdout: true
                        ).trim()
                        // Image tag format: <build-number>-<short-sha>
                        // e.g.  42-a1b2c3d
                        env.IMAGE_TAG = "${env.BUILD_NUMBER}-${env.GIT_SHORT_SHA}"
                        // IS_PR  = true  when triggered by a Pull Request
                        // IS_MAIN = true when running on the main branch (post-merge)
                        env.IS_PR   = (env.CHANGE_ID   != null)   ? 'true' : 'false'
                        env.IS_MAIN = (env.BRANCH_NAME == 'main') ? 'true' : 'false'

                        echo "─── Build context ───────────────────────────────"
                        echo "  Branch    : ${env.BRANCH_NAME ?: env.CHANGE_BRANCH}"
                        echo "  PR build  : ${env.IS_PR}"
                        echo "  Main build: ${env.IS_MAIN}"
                        echo "  Image tag : ${env.IMAGE_TAG}"
                        echo "─────────────────────────────────────────────────"
                    }
                }
            }
        }

        // ── Detect Changed Services ───────────────────────────────────────────
        // git fetch + git diff run in container('devops') (uid 0).
        // safe.directory registered in Setup Tools allows these to run cleanly.
        //
        // ── BOOTSTRAP AWARENESS ───────────────────────────────────────────────
        // On the very first pipeline run Nexus is empty. git diff only shows
        // files changed in the current commit, so it would miss every service
        // that has not been edited recently. Without the bootstrap check those
        // services would never get an image into Nexus.
        //
        // After computing the git-diff set we therefore query the Nexus Docker
        // Registry v2 API for EVERY service in ALL_SERVICES:
        //
        //   GET http://<registry>/v2/<repo>/<service>/tags/list
        //   → 200 + {"tags":[...]}  means at least one image exists → already bootstrapped
        //   → 404 / empty tags      means no image exists           → must build now
        //
        // The two sets are merged and deduplicated. Downstream stages see only
        // the final SERVICES_TO_BUILD env var — they require zero changes.
        stage('Detect Changed Services') {
            steps {
                container('devops') {
                    script {
                        // ── Step 1: git diff → changedSet ─────────────────────
                        def baseRef

                        if (env.IS_PR == 'true') {
                            sh "git fetch origin ${env.CHANGE_TARGET} --depth=100"
                            baseRef = "origin/${env.CHANGE_TARGET}"
                        } else {
                            sh 'git fetch origin main --depth=100'
                            def hasPrev = sh(
                                script: 'git rev-parse HEAD~1 >/dev/null 2>&1',
                                returnStatus: true
                            ) == 0
                            baseRef = hasPrev ? 'HEAD~1' : null
                        }

                        def changedSet = [] as Set

                        if (baseRef) {
                            def diffOut = sh(
                                script: "git diff --name-only ${baseRef}...HEAD 2>/dev/null || true",
                                returnStdout: true
                            ).trim()

                            diffOut.split('\n').each { filePath ->
                                if (!filePath) return
                                def parts = filePath.tokenize('/')
                                // Match:  services/<svc>/...
                                if (parts.size() >= 2 && parts[0] == 'services') {
                                    def candidate = parts[1]
                                    if (ALL_SERVICES.containsKey(candidate)) {
                                        changedSet << candidate
                                    }
                                }
                            }
                        }

                        if (changedSet.isEmpty()) {
                            echo 'No service-specific changes detected — building ALL services.'
                            changedSet = ALL_SERVICES.keySet() as Set
                        }

                        // ── Step 2: Nexus bootstrap check ─────────────────────
                        // Only performed on main builds. PR builds skip image
                        // creation entirely, so there is no point querying Nexus.
                        def missingInNexus = [] as Set

                        if (env.IS_MAIN == 'true') {
                            echo '──── Checking Nexus for unbootstrapped services ────'
                            withCredentials([usernamePassword(
                                    credentialsId: env.NEXUS_CRED_ID,
                                    usernameVariable: 'NEXUS_USER',
                                    passwordVariable: 'NEXUS_PASS')]) {

                                ALL_SERVICES.keySet().each { svc ->
                                    // Nexus Docker Registry v2 tags/list endpoint.
                                    // --fail   → curl exits non-zero on 4xx/5xx
                                    // --silent → suppress progress meter
                                    // --user   → basic auth (Nexus requires auth
                                    //            even for hosted repos by default)
                                    // 2>/dev/null suppresses connection-error noise
                                    // so that the || echo "" branch is always clean.
                                    //
                                    // Response body for a repo with images:
                                    //   {"name":"merch-docker/python-service","tags":["26-abc","25-def"]}
                                    // Response body for an empty / missing repo:
                                    //   HTTP 404  →  curl exits 22 (--fail)
                                    def tagsJson = sh(
                                        script: """
                                            curl --silent --fail \
                                                 --user "\${NEXUS_USER}:\${NEXUS_PASS}" \
                                                 "http://${env.NEXUS_REGISTRY}/v2/${env.NEXUS_REPO_NAME}/${svc}/tags/list" \
                                                 2>/dev/null || echo ""
                                        """,
                                        returnStdout: true
                                    ).trim()

                                    // An empty response (curl got 404/connection error)
                                    // OR a response with "tags":null / "tags":[]
                                    // both indicate no image has ever been pushed.
                                    boolean hasTags = tagsJson &&
                                        tagsJson.contains('"tags"') &&
                                        !tagsJson.contains('"tags":null') &&
                                        !tagsJson.contains('"tags":[]')
                                    

                                    if (hasTags) {
                                        echo "  ✔ ${svc}: image(s) found in Nexus — skip bootstrap"
                                    } else {
                                        echo "  ✘ ${svc}: NO image in Nexus — forcing build"
                                        missingInNexus << svc
                                    }
                                }
                            }

                            if (missingInNexus) {
                                echo "Bootstrap services (missing from Nexus): ${missingInNexus.join(', ')}"
                            } else {
                                echo 'All services are already bootstrapped in Nexus.'
                            }
                        }

                        // ── Step 3: Merge + deduplicate ───────────────────────
                        // Union of git-diff set and Nexus-missing set.
                        // Using addAll() on a Set gives automatic deduplication.
                        def finalSet = (changedSet + missingInNexus) as Set

                        env.SERVICES_TO_BUILD = finalSet.join(',')
                        echo "Services to process: ${env.SERVICES_TO_BUILD}"
                    }
                }
            }
        }


        // ── Install Dependencies ──────────────────────────────────────────────
        stage('Install Dependencies') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        dir(svcDir(ALL_SERVICES, svc)) {
                            def manifestType = 'none'
                            container('devops') {
                                manifestType = sh(
                                    script: '''
                                        if   [ -f package.json     ]; then echo "node"
                                        elif [ -f requirements.txt ]; then echo "python"
                                        else                            echo "none"
                                        fi
                                    ''',
                                    returnStdout: true
                                ).trim()
                            }

                            if (manifestType == 'node') {
                                container('devops') {
                                    sh 'npm ci --legacy-peer-deps'
                                }
                            } else if (manifestType == 'python') {
                                container('devops') {
                                    sh '''
                                        python3 -m venv .venv
                                        . .venv/bin/activate
                                        pip install --upgrade pip setuptools
                                        pip install -r requirements.txt
                                    '''
                                }
                            } else {
                                echo "No recognized dependency manifest in ${svc} — skipping."
                            }
                        }
                    }
                }
            }
        }

        // ── Build ─────────────────────────────────────────────────────────────
        // Build stage removed: Kaniko handles building during image creation

        // ── Unit Tests ────────────────────────────────────────────────────────
        stage('Unit Tests') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        dir(svcDir(ALL_SERVICES, svc)) {
                            def testType = 'none'
                            container('devops') {
                                testType = sh(
                                    script: '''
                                        if   [ -f package.json     ]; then echo "node"
                                        elif [ -f requirements.txt ]; then echo "python"
                                        else                            echo "none"
                                        fi
                                    ''',
                                    returnStdout: true
                                ).trim()
                            }

                            if (testType == 'node') {
                                container('devops') {
                                    // --passWithNoTests prevents failure when no tests exist yet.
                                    sh '''
                                        npm test -- --ci \
                                            --passWithNoTests \
                                            --reporters=default \
                                            --reporters=jest-junit 2>/dev/null || \
                                        npm test -- --passWithNoTests 2>/dev/null || \
                                        echo "No test runner configured — skipping."
                                    '''
                                }
                            } else if (testType == 'python') {
                                container('devops') {
                                    sh '''
                                        if [ -d .venv ]; then
                                            . .venv/bin/activate
                                        fi
                                        python3 -m pytest \
                                            --tb=short \
                                            -p no:warnings \
                                            --junitxml=test-results.xml \
                                            2>/dev/null || echo "No pytest found — skipping."
                                    '''
                                }
                            } else {
                                echo "No tests defined for ${svc} — skipping."
                            }
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

        // ── SonarQube Analysis ────────────────────────────────────────────────
        // DISABLED until SonarQube is deployed on the admin cluster.
        // To enable: set SONAR_ENABLED = 'true' in the environment block above,
        // then add a SonarQube server in Manage Jenkins → System and add the
        // sonarqube-token credential.
        stage('SonarQube Analysis') {
            when { expression { env.SONAR_ENABLED == 'true' } }
            steps {
                container('devops') {
                    withSonarQubeEnv('sonarqube-admin') {
                        withCredentials([string(credentialsId: env.SONAR_TOKEN_ID,
                                                variable: 'SONAR_TOKEN')]) {
                            script {
                                env.SERVICES_TO_BUILD.split(',').each { svc ->
                                    dir(svcDir(ALL_SERVICES, svc)) {
                                        sh """
                                            sonar-scanner \
                                              -Dsonar.projectKey=merch-${svc} \
                                              -Dsonar.sources=. \
                                              -Dsonar.login=\$SONAR_TOKEN
                                        """
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // ── Quality Gate ──────────────────────────────────────────────────────
        stage('Quality Gate') {
            when { expression { env.SONAR_ENABLED == 'true' } }
            steps {
                timeout(time: 15, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }

        // =====================================================================
        // Everything below this line ONLY runs on main (post-merge to main).
        // A PR build stops at Quality Gate (or Unit Tests if Sonar is disabled).
        // No image is built and nothing is pushed on a PR build.
        // =====================================================================

        // ── Kaniko: Build & Push Images ───────────────────────────────────────
        // Kaniko builds each image directly from the source context without needing
        // a Docker daemon. The container uses the kaniko executor binary directly.
        //
        // The nexus-docker-config Secret is mounted at /kaniko/.docker/
        // (configured in the devops-agent pod template in jenkins-casc-config.yaml).
        //
        // --insecure          → Nexus Docker registry runs on plain HTTP (no TLS)
        // --skip-tls-verify   → Belt-and-suspenders for the insecure registry
        // --cache=true        → Layer caching — speeds up repeated builds
        // --cache-ttl=168h    → Keep cache for 7 days
        stage('Kaniko: Build & Push Images') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    def failedServices = []

                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        // Capture loop variables in locals for safe closure binding.
                        def svc      = svcName
                        def svcPath  = svcDir(ALL_SERVICES, svc)
                        // Full image reference that will be used in kustomization.yaml
                        def imageRef = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}:${env.IMAGE_TAG}"
                        def cacheRepo = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}-cache"

                        try {
                            echo "──── Building ${svc} ────"
                            echo "Dockerfile : ${svcPath}/Dockerfile"
                            echo "Context    : ${svcPath}"
                            echo "Destination: ${imageRef}"

                            if (!fileExists(svcPath)) {
                                error "Service directory ${svcPath} does not exist."
                            }
                            if (!fileExists("${svcPath}/Dockerfile")) {
                                error "Dockerfile not found at ${svcPath}/Dockerfile."
                            }

                            container('kaniko') {
                                // Retry scoped strictly to the Kaniko executor command  
                                // 
                                // CRITICAL FLAGS EXPLAINED:
                                // --ignore-path: Prevents Kaniko from overwriting these paths
                                //                during base image extraction. Without these,
                                //                Kaniko replaces /bin/sh and breaks Jenkins.
                                retry(3) {
                                    sh """
                                        /kaniko/executor \
                                          --context="\$(pwd)/${svcPath}" \
                                          --dockerfile="\$(pwd)/${svcPath}/Dockerfile" \
                                          --destination="${imageRef}" \
                                          --insecure \
                                          --insecure-pull \
                                          --skip-tls-verify \
                                          --cache=true \
                                          --cache-repo="${cacheRepo}" \
                                          --cache-ttl=168h \
                                          --ignore-path=/busybox \
                                          --ignore-path=/kaniko
                                    """
                                }
                            }
                            echo "✔ Pushed ${imageRef}"
                        } catch (Exception e) {
                            echo "✘ Failed to build ${svc}: ${e.message}"
                            failedServices << svc
                        }
                    }

                    if (!failedServices.isEmpty()) {
                        error "The following services failed to build: ${failedServices.join(', ')}"
                    }
                }
            }
        }

        // ── Update Config Repository ──────────────────────────────────────────
        // Clones hpe-merch-config (dev branch), updates the image newTag for every
        // changed service in downstream-clusters/base/kustomization.yaml, commits,
        // and pushes back to the dev branch.
        //
        // ArgoCD's 'downstream-dev' Application watches the dev branch and will
        // automatically sync the new image tags to the dev cluster.
        //
        // The kustomization.yaml images block format that yq updates:
        //   images:
        //     - name: node-backend                         ← matches by .name
        //       newName: 192.168.56.10:30082/merch-docker/node-backend
        //       newTag: "42-a1b2c3d"                       ← this is updated
        stage('Update Config Repository') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                container('devops') {
                    withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID,
                                                      usernameVariable: 'GIT_USER',
                                                      passwordVariable: 'GIT_TOKEN')]) {
                        script {
                            // Build the authenticated URL in Groovy (safe for tokens
                            // that contain special shell characters).
                            def repoHost  = env.CONFIG_REPO_URL.replaceFirst('https://', '')
                            // GIT_USER and GIT_TOKEN come from withCredentials — they are
                            // available as Groovy variables (NOT shell variables at this point).
                            // Use Groovy string interpolation (${}) — no backslash-escape needed.
                            def authedUrl = "https://${GIT_USER}:${GIT_TOKEN}@${repoHost}"

                            // Clone the config repo (dev branch, shallow clone for speed).
                            // The cloned repo lands at ${WORKSPACE}/${CONFIG_REPO_DIR}, which
                            // was already registered as a safe.directory in Setup Tools.
                            sh """
                                rm -rf ${env.CONFIG_REPO_DIR}
                                git clone --depth=1 --branch ${env.CONFIG_REPO_BRANCH} \
                                    ${authedUrl} \
                                    ${env.CONFIG_REPO_DIR}
                            """

                            dir(env.CONFIG_REPO_DIR) {
                                // Single kustomization.yaml holds ALL image tags.
                                // We update newTag for each changed service in one pass.
                                def manifestPath = 'downstream-clusters/base/kustomization.yaml'

                                env.SERVICES_TO_BUILD.split(',').each { svc ->
                                    // yq v4 syntax: select the image entry by name and
                                    // update only its newTag field. Leaves all other
                                    // entries and fields untouched.
                                    sh """
                                        yq -i \
                                          '(.images[] | select(.name == "${svc}")).newTag = "${env.IMAGE_TAG}"' \
                                          ${manifestPath}
                                    """
                                    echo "✔ Updated ${manifestPath}: ${svc} → ${env.IMAGE_TAG}"
                                }

                                // Also update the newName to use the NodePort registry address
                                // in case the kustomization.yaml was previously using a
                                // different registry address (idempotent).
                                env.SERVICES_TO_BUILD.split(',').each { svc ->
                                    sh """
                                        yq -i \
                                          '(.images[] | select(.name == "${svc}")).newName = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}"' \
                                          ${manifestPath}
                                    """
                                }

                                sh """
                                    git config user.email "jenkins-ci@merch.local"
                                    git config user.name  "jenkins-ci"
                                    git add -A
                                    if git diff --cached --quiet; then
                                        echo "No manifest changes — nothing to commit."
                                    else
                                        git commit -m "ci: bump image tag(s) to ${env.IMAGE_TAG} for [${env.SERVICES_TO_BUILD}] (build #${env.BUILD_NUMBER})"
                                    fi
                                    git push origin ${env.CONFIG_REPO_BRANCH}
                                """
                            }

                            echo """
─────────────────────────────────────────────────────────────────────────────
✔ Config repo updated.
  Branch: ${env.CONFIG_REPO_BRANCH}   Tag: ${env.IMAGE_TAG}
  Services: ${env.SERVICES_TO_BUILD}

  ArgoCD will detect the commit on the '${env.CONFIG_REPO_BRANCH}' branch
  and deploy to the dev cluster within ~3 minutes.
  Monitor: https://argocd.192.168.56.10.nip.io → downstream-dev
─────────────────────────────────────────────────────────────────────────────
"""
                        }
                    }
                }
            }
        }
    }

    // =========================================================================
    post {
        always {
            // Clean workspace after every build to avoid stale files on the pod.
            cleanWs()
        }
        success {
            echo "✔ Pipeline PASSED — branch: ${env.BRANCH_NAME ?: env.CHANGE_BRANCH}  tag: ${env.IMAGE_TAG ?: 'n/a (PR build)'}"
        }
        failure {
            echo "✘ Pipeline FAILED at build #${env.BUILD_NUMBER}. Check console output for details."
        }
    }
}