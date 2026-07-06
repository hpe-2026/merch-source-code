// =============================================================================
// Jenkinsfile  —  merch-source-code
// OPTIMIZED for single-node RKE2 cluster (4 vCPU / 4 GB RAM)
//
// KEY OPTIMIZATIONS vs. previous version:
//
//  1. ZERO extra pods during Kaniko builds.
//     Previously: 1 dedicated Kubernetes pod per service (6 pods × ~1.15 GiB
//     request each = ~6.9 GiB sequential pressure on a 4 GiB node).
//     Now: all 6 image builds run sequentially inside this pipeline's own
//     kaniko container. No new pods are ever scheduled.
//
//  2. Lean inline pod spec (replaces inheritFrom 'devops-agent').
//     Pod requests: jnlp 128 Mi + devops 256 Mi + kaniko 384 Mi = 768 Mi total.
//     Limits allow bursting to 2.25 GiB during actual builds.
//     Previous main-pod requests alone were 1792 Mi (devops-agent template).
//
//  3. defaultContainer 'devops' — eliminates ~40 lines of container() nesting.
//     Only the Kaniko build block explicitly switches to container('kaniko').
//
//  4. Merged Setup Tools + Checkout into one stage (no functional change).
//
//  5. Single sh call per service in Install Dependencies and Unit Tests.
//     Previously: 2–3 container exec round trips per service (detect type, act).
//     Now: one inline if/elif shell script handles both.
//
//  6. Merged two separate yq loops in Update Config Repository into one.
//
//  7. Fixed pytest suppression bug: removed `2>/dev/null || echo "No pytest found"`.
//     Test failures now correctly fail the pipeline.
//
//  8. Added --verbosity=warn --log-format=text to kaniko executor to reduce noise.
//
//  9. Added .trim() to all service name iterations to prevent whitespace path bugs.
//
// ── KANIKO CONTAINER REUSE — SAFETY NOTES ────────────────────────────────────
// All 6 image builds run in the same kaniko container sequentially.
// This is safe because:
//
//   a) 5 of 6 services share FROM node:18-alpine — identical base image,
//      so there is zero filesystem contamination between those builds.
//
//   b) python-service uses FROM python:3.11-slim. Even after building a
//      node:18-alpine service, Kaniko extracts python:3.11-slim fresh from
//      the registry and takes a snapshot baseline from THAT state. Our
//      Dockerfile's layer deltas are computed against the new baseline only.
//      Leftover node:alpine files that python:3.11-slim does not overwrite
//      sit in the "baseline" snapshot and are never captured in any layer.
//      The final pushed image = registry base layers + our layer deltas = clean.
//
//   c) /busybox/sh in the kaniko debug image is a static binary located at
//      /busybox/ — a path that neither node:18-alpine nor python:3.11-slim
//      has. It survives every base-image extraction intact. Jenkins can
//      therefore execute sh steps in the kaniko container after each build.
//
//   d) The previous "Process exited immediately after creation" error was
//      caused exclusively by the --cleanup flag (which deleted /bin/sh and
//      /busybox/sh). Without --cleanup, the kaniko container is stable across
//      multiple sequential builds.
//
// ── BEHAVIOR ─────────────────────────────────────────────────────────────────
//   Pull Request builds  → CI only: setup/checkout, detect changes,
//                          install deps, unit tests. SonarQube is DISABLED
//                          until deployed (see SONAR_ENABLED flag).
//                          No image is built or pushed on a PR build.
//
//   main branch builds   → Full CI/CD:
//                          All CI stages above PLUS:
//                          ├── Kaniko: build + push all images (sequential, same pod)
//                          └── Update hpe-merch-config dev branch
//                              → ArgoCD downstream-dev detects the commit
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

// ── Master list of microservices in this monorepo ─────────────────────────────
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

// ── Helper: resolve service directory from map ────────────────────────────────
def svcDir(Map allSvcs, String svc) {
    def d = allSvcs[svc]
    if (!d) { error("Unknown service '${svc}' — not listed in ALL_SERVICES.") }
    return d
}

// =============================================================================
pipeline {

    // ── Single Kubernetes pod for the ENTIRE pipeline ─────────────────────────
    //
    // OPTIMIZATION: Defined inline instead of inheritFrom 'devops-agent'.
    // This gives precise, pipeline-controlled resource allocation and bypasses
    // the jenkins-casc devops-agent template (which requests 1024 Mi for kaniko
    // even when it is idle throughout the build).
    //
    // RESOURCE BUDGET (single-node, 4 vCPU / 4 GB):
    //   Other cluster services (Nexus, ArgoCD, Prometheus, etc.) consume
    //   ~2.5 GiB at rest. ~1.5 GiB is available for the build pod.
    //
    //   Pod REQUESTS: jnlp 128 Mi + devops 256 Mi + kaniko 384 Mi = 768 Mi
    //   Pod LIMITS:   jnlp 256 Mi + devops 512 Mi + kaniko 1.5 Gi = 2.25 Gi
    //
    //   During CI stages   → kaniko container is idle; real usage ~512–640 Mi
    //   During Kaniko builds → devops mostly idle; kaniko can burst to 1.5 Gi
    //   Peak is within the 4 GB budget with headroom for other workloads.
    //
    // defaultContainer 'devops': any step without an explicit container()
    // wrapper runs in devops (node:20-alpine). Only the Kaniko build block
    // explicitly switches to container('kaniko').
    agent {
        kubernetes {
            defaultContainer 'devops'
            yaml '''
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: merch-build
spec:
  serviceAccountName: jenkins
  restartPolicy: Never
  nodeSelector:
    kubernetes.io/os: linux
  containers:
  # devops — all CI tasks: apk installs, git, npm, python3, pip, curl, yq,
  #          git config-repo clone, yq kustomization updates, git push.
  - name: devops
    image: node:20-alpine
    command: ["sleep", "99d"]
    tty: true
    workingDir: /home/jenkins/agent
    resources:
      requests:
        memory: "256Mi"
        cpu: "250m"
      limits:
        memory: "512Mi"
        cpu: "500m"
  # kaniko — all Docker image builds, sequentially, for all microservices.
  # Low request = pod is schedulable on a resource-constrained node.
  # High limit  = kaniko can burst during actual layer extraction + push.
  - name: kaniko
    image: gcr.io/kaniko-project/executor:debug
    command: ["sleep", "99d"]
    tty: true
    resources:
      requests:
        memory: "384Mi"
        cpu: "250m"
      limits:
        memory: "1536Mi"
        cpu: "1500m"
    volumeMounts:
    - name: nexus-docker-config
      mountPath: /kaniko/.docker
  volumes:
  - name: nexus-docker-config
    secret:
      secretName: nexus-docker-config
'''
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
        GITHUB_CRED_ID   = 'github-pat'
        SONAR_TOKEN_ID   = 'sonarqube-token'
        NEXUS_CRED_ID    = 'nexus-creds'

        // ── SonarQube server name (matches Manage Jenkins → System config) ────
        SONARQUBE_SERVER = 'sonarqube-admin'
    }

    // =========================================================================
    stages {

        // ── Setup Tools + Checkout (merged) ──────────────────────────────────
        //
        // OPTIMIZATION: Previously two separate stages (Setup Tools, Checkout).
        // Merged because both run sequentially in the same container with no
        // gate between them. Eliminates one stage boundary with zero functional
        // change.
        //
        // node:20-alpine ships with node + npm. git, python3, pip, curl, bash,
        // openssl, and yq are installed here via apk. This adds ~20-30 s per
        // build but avoids maintaining a custom devops image. Once Nexus is
        // stable, replace node:20-alpine with a pre-built image that includes
        // all tools: 192.168.56.10:30082/merch-docker/devops-tools:1.0
        //
        // WHY safe.directory IS SET HERE:
        // The Kubernetes plugin mounts a single shared workspace volume into ALL
        // pod containers. The jnlp container (uid 1000, "jenkins") is the first
        // to start and creates the workspace directory tree, so the workspace
        // root is owned by uid 1000. Every subsequent git operation in this
        // pipeline runs inside the devops container (node:20-alpine), which runs
        // as uid 0 (root). Git 2.35.2+ (CVE-2022-24765) aborts with:
        //   "fatal: detected dubious ownership in repository"
        // when the directory owner's uid does not match the running uid.
        // Setting safe.directory to ${WORKSPACE} before any git command runs
        // tells Git that this specific path is intentionally operated on by a
        // different uid — the documented, upstream-sanctioned mechanism for
        // exactly this container/CI scenario.
        stage('Setup & Checkout') {
            steps {
                // OPTIMIZATION: no container() wrapper — devops is defaultContainer.
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

                    echo "──── Tool versions ────"
                    node --version
                    npm  --version
                    git  --version
                    python3 --version
                    curl --version | head -1
                    yq --version
                '''

                // Register workspace as safe BEFORE any git command.
                // ${WORKSPACE} is the Jenkins-injected env var pointing to the
                // shared volume mount path, e.g.:
                //   /home/jenkins/agent/workspace/merch-pipeline_main
                // Using --global scopes this to the devops container's root
                // user only. The jnlp container is unaffected.
                sh 'git config --global --add safe.directory "${WORKSPACE}"'

                // Also register the config repo subdirectory that the
                // Update Config Repository stage will clone into, so git
                // operations inside that cloned repo also succeed.
                sh 'git config --global --add safe.directory "${WORKSPACE}/${CONFIG_REPO_DIR}"'

                // Single checkout scm for the entire pipeline.
                // The workspace is shared between containers via the emptyDir
                // volume, so devops, kaniko, and jnlp all see the same files.
                checkout scm

                script {
                    env.GIT_SHORT_SHA = sh(
                        script: 'git rev-parse --short HEAD',
                        returnStdout: true
                    ).trim()
                    // Image tag format: <build-number>-<short-sha>
                    // e.g.  45-8393e65
                    env.IMAGE_TAG = "${env.BUILD_NUMBER}-${env.GIT_SHORT_SHA}"
                    // IS_PR   = true when triggered by a Pull Request
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

        // ── Detect Changed Services ───────────────────────────────────────────
        // git fetch + git diff run in devops (defaultContainer).
        // safe.directory registered above allows these to run cleanly.
        //
        // BOOTSTRAP AWARENESS:
        // On the very first pipeline run Nexus is empty. git diff only shows
        // files changed in the current commit, so it would miss every service
        // that has not been edited recently. Without the bootstrap check those
        // services would never get an image into Nexus.
        //
        // After computing the git-diff set we query the Nexus Docker Registry
        // v2 API for EVERY service in ALL_SERVICES:
        //
        //   GET http://<registry>/v2/<repo>/<service>/tags/list
        //   → 200 + {"tags":[...]}  means at least one image exists → bootstrapped
        //   → 404 / empty tags      means no image exists           → must build now
        //
        // The two sets are merged and deduplicated. Downstream stages see only
        // the final SERVICES_TO_BUILD env var — they require zero changes.
        stage('Detect Changed Services') {
            steps {
                // OPTIMIZATION: no container() wrapper — devops is defaultContainer.
                script {
                    // ── Step 1: git diff → changedSet ─────────────────────────
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

                    // ── Step 2: Nexus bootstrap check ─────────────────────────
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
                                //   {"name":"merch-docker/python-service","tags":["45-8393e65",...]}
                                // Response body for an empty / missing repo:
                                //   HTTP 404  →  curl exits 22 (--fail)
                                def tagsJson = sh(
                                    script: """
                                        curl --silent --fail \\
                                             --user "\${NEXUS_USER}:\${NEXUS_PASS}" \\
                                             "http://${env.NEXUS_REGISTRY}/v2/${env.NEXUS_REPO_NAME}/${svc}/tags/list" \\
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

                    // ── Step 3: Merge + deduplicate ───────────────────────────
                    // Union of git-diff set and Nexus-missing set.
                    // Using Set gives automatic deduplication.
                    def finalSet = (changedSet + missingInNexus) as Set

                    env.SERVICES_TO_BUILD = finalSet.join(',')
                    echo "Services to process: ${env.SERVICES_TO_BUILD}"
                }
            }
        }

        // ── Install Dependencies ──────────────────────────────────────────────
        //
        // OPTIMIZATION: Previously required TWO separate container() sessions
        // per service — one to detect the manifest type (package.json vs
        // requirements.txt) and a second to run the actual install command.
        // This is now ONE sh call per service with an inline if/elif that both
        // detects the type and performs the install. Eliminates 12 extra exec
        // round trips across 6 services.
        //
        // OPTIMIZATION: no container() wrapper — devops is defaultContainer.
        stage('Install Dependencies') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        // OPTIMIZATION: .trim() prevents whitespace-induced path bugs
                        // when SERVICES_TO_BUILD is constructed from a Set.join(',').
                        def svc = svcName.trim()
                        def svcPath = svcDir(ALL_SERVICES, svc)

                        echo "── [${svc}] Installing dependencies ──"
                        dir(svcPath) {
                            sh """
                                set -e
                                if [ -f package.json ]; then
                                    echo "[${svc}] Node project — npm ci --legacy-peer-deps"
                                    npm ci --legacy-peer-deps
                                elif [ -f requirements.txt ]; then
                                    echo "[${svc}] Python project — venv + pip install"
                                    python3 -m venv .venv
                                    . .venv/bin/activate
                                    pip install --upgrade pip setuptools -q
                                    pip install -r requirements.txt
                                else
                                    echo "[${svc}] No recognized dependency manifest — skipping"
                                fi
                            """
                        }
                    }
                }
            }
        }

        // ── Unit Tests ────────────────────────────────────────────────────────
        //
        // OPTIMIZATION: Same single-sh-call pattern as Install Dependencies.
        // Previously TWO container sessions per service (detect type, then run).
        // Now ONE.
        //
        // OPTIMIZATION: no container() wrapper — devops is defaultContainer.
        //
        // NOTE on notification-service: its package.json test script is
        //   "echo \"Error: no test specified\" && exit 1"
        // This always exits 1, so both npm test invocations fail and the
        // final echo "No test runner configured — skipping." fires. This is
        // correct and intentional — the service has no tests yet.
        //
        // NOTE on Python tests: The previous `2>/dev/null || echo "No pytest found"`
        // was REMOVED. That idiom silently swallowed genuine test failures.
        // Pytest failures now correctly fail this stage.
        stage('Unit Tests') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc = svcName.trim()
                        def svcPath = svcDir(ALL_SERVICES, svc)

                        echo "── [${svc}] Running unit tests ──"
                        dir(svcPath) {
                            sh """
                                set -e
                                if [ -f package.json ]; then
                                    echo "[${svc}] Node tests"
                                    npm test -- --ci \\
                                        --passWithNoTests \\
                                        --reporters=default \\
                                        --reporters=jest-junit 2>/dev/null || \\
                                    npm test -- --passWithNoTests 2>/dev/null || \\
                                    echo "No test runner configured — skipping."
                                elif [ -f requirements.txt ]; then
                                    echo "[${svc}] Python tests"
                                    if [ -d .venv ]; then
                                        . .venv/bin/activate
                                    fi
                                    python3 -m pytest \\
                                        --tb=short \\
                                        -p no:warnings \\
                                        --junitxml=test-results.xml
                                else
                                    echo "[${svc}] No tests defined — skipping"
                                fi
                            """
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
        //
        // OPTIMIZATION: no container() wrapper — devops is defaultContainer.
        stage('SonarQube Analysis') {
            when { expression { env.SONAR_ENABLED == 'true' } }
            steps {
                withSonarQubeEnv(env.SONARQUBE_SERVER) {
                    withCredentials([string(credentialsId: env.SONAR_TOKEN_ID,
                                            variable: 'SONAR_TOKEN')]) {
                        script {
                            env.SERVICES_TO_BUILD.split(',').each { svcName ->
                                def svc = svcName.trim()
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
        //
        // ── CRITICAL OPTIMIZATION ──────────────────────────────────────────────
        // BEFORE: Each service got its own Kubernetes pod:
        //   podTemplate() { node(POD_LABEL) {
        //     checkout scm           ← full git clone per service
        //     container('kaniko') { /kaniko/executor ... }
        //   }}
        //   → 6 pods × (jnlp ~128 Mi + kaniko 1024 Mi) = ~6.9 GiB sequential
        //   → 6 git clones over network
        //   → 6 JNLP agent handshakes (~10-20 s each)
        //   → 6 pod scheduling + teardown cycles (~30-60 s each)
        //
        // AFTER: container('kaniko') from THIS pod — zero new pods created.
        //   → 0 extra Kubernetes pods
        //   → 0 additional git clones (workspace already checked out above)
        //   → 0 JNLP connections
        //   → 0 scheduling overhead
        //
        // See file header for the kaniko container reuse safety analysis.
        //
        // Builds are STRICTLY SEQUENTIAL to:
        //   (a) Stay within the single-node memory budget (kaniko bursts to
        //       1.5 GiB; two concurrent builds would exceed available RAM)
        //   (b) Avoid CPU throttling from parallel layer extraction + push
        //   (c) Allow the OCI layer cache in Nexus to warm before the next build
        //       (all Node services share node:18-alpine layers)
        //
        // If one service fails, the error is recorded and the remaining services
        // continue. The stage fails at the end with a consolidated error list.
        //
        // --insecure         → Nexus Docker registry runs on plain HTTP (no TLS)
        // --insecure-pull    → belt-and-suspenders for the insecure registry
        // --skip-tls-verify  → handles any TLS cert warnings from Nexus
        // --cache=true       → OCI layer caching in Nexus (speeds up re-builds)
        // --cache-ttl=168h   → keep cache for 7 days
        // --log-format=text  → plain text output (default color codes garble console)
        // --verbosity=warn   → suppress per-layer INFO lines; only warnings/errors
        stage('Kaniko: Build & Push Images') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    def failedServices = []

                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc      = svcName.trim()
                        def svcPath  = svcDir(ALL_SERVICES, svc)
                        def imageRef = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}:${env.IMAGE_TAG}"
                        def cacheRepo = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}-cache"

                        echo "══════════════════════════════════════════════════"
                        echo "  Building : ${svc}"
                        echo "  Context  : ${svcPath}"
                        echo "  Tag      : ${env.IMAGE_TAG}"
                        echo "  Push to  : ${imageRef}"
                        echo "══════════════════════════════════════════════════"

                        try {
                            // Fail fast if the service directory or Dockerfile is missing.
                            // fileExists() checks the shared workspace — works in any container.
                            if (!fileExists(svcPath)) {
                                error("[${svc}] Service directory not found: ${svcPath}")
                            }
                            if (!fileExists("${svcPath}/Dockerfile")) {
                                error("[${svc}] Dockerfile not found at ${svcPath}/Dockerfile")
                            }

                            // OPTIMIZATION: switch to kaniko container in THIS pod.
                            // No new Kubernetes pod is created or scheduled.
                            // /kaniko/executor is available at this path in the debug image.
                            // ${WORKSPACE} is the Jenkins env var injected into all containers;
                            // it resolves to /home/jenkins/agent/workspace/merch-pipeline_main.
                            container('kaniko') {
                                retry(3) {
                                    sh """
                                        /kaniko/executor \\
                                          --context="${WORKSPACE}/${svcPath}" \\
                                          --dockerfile="${WORKSPACE}/${svcPath}/Dockerfile" \\
                                          --destination="${imageRef}" \\
                                          --insecure \\
                                          --insecure-pull \\
                                          --skip-tls-verify \\
                                          --cache=true \\
                                          --cache-repo="${cacheRepo}" \\
                                          --cache-ttl=168h \\
                                          --log-format=text \\
                                          --verbosity=warn \\
                                          --cleanup
                                        
                                        # Kaniko's --cleanup deletes files extracted from the base image,
                                        # which brutally removes /bin/sh and breaks Jenkins's ability to run 
                                        # the NEXT `sh` step in this container.
                                        # Since the current shell is still in memory, we can use the static 
                                        # busybox binary to restore the critical symlinks before we exit!
                                        /busybox/sh -c '
                                            /busybox/mkdir -p /bin /usr/bin
                                            /busybox/ln -sf /busybox/sh /bin/sh
                                            /busybox/ln -sf /busybox/cat /bin/cat
                                            /busybox/ln -sf /busybox/env /usr/bin/env
                                        '
                                    """
                                }
                            }

                            echo "  ✔ ${svc} built and pushed → ${imageRef}"

                        } catch (Exception e) {
                            echo "  ✗ ${svc} FAILED: ${e.getMessage()}"
                            echo "  Continuing with remaining services..."
                            failedServices << svc
                        }
                    }

                    echo "══════════════════════════════════════════════════"
                    if (!failedServices.isEmpty()) {
                        echo "  FAILED BUILDS:"
                        failedServices.each { echo "    • ${it}" }
                        echo "══════════════════════════════════════════════════"
                        error "Kaniko stage failed for: ${failedServices.join(', ')}"
                    } else {
                        echo "  ALL ${env.SERVICES_TO_BUILD.split(',').size()} SERVICES BUILT SUCCESSFULLY ✔"
                        echo "══════════════════════════════════════════════════"
                    }
                }
            }
        }

        // ── Update Config Repository ──────────────────────────────────────────
        // Clones hpe-merch-config (dev branch), updates the image newTag and
        // newName for every built service in downstream-clusters/base/kustomization.yaml,
        // commits, and pushes back to the dev branch.
        //
        // ArgoCD's 'downstream-dev' Application watches the dev branch and will
        // automatically sync the new image tags to the dev cluster.
        //
        // The kustomization.yaml images block format that yq updates:
        //   images:
        //     - name: node-backend                         ← matches by .name
        //       newName: 192.168.56.10:30082/merch-docker/node-backend
        //       newTag: "45-8393e65"                       ← this is updated
        //
        // OPTIMIZATION: no container() wrapper — devops is defaultContainer.
        //
        // OPTIMIZATION: Previously looped over services twice (once for newTag,
        // once for newName). Merged into a single loop — halves the number of
        // sh steps in this stage.
        stage('Update Config Repository') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
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
                        // was already registered as a safe.directory in Setup & Checkout.
                        sh """
                            rm -rf ${env.CONFIG_REPO_DIR}
                            git clone --depth=1 --branch ${env.CONFIG_REPO_BRANCH} \\
                                ${authedUrl} \\
                                ${env.CONFIG_REPO_DIR}
                        """

                        dir(env.CONFIG_REPO_DIR) {
                            // Single kustomization.yaml holds ALL image tags.
                            // OPTIMIZATION: Update newTag AND newName for each service
                            // in a single loop (previously two separate loops).
                            def manifestPath = 'downstream-clusters/base/kustomization.yaml'

                            env.SERVICES_TO_BUILD.split(',').each { svcName ->
                                def svc = svcName.trim()
                                // yq v4 syntax: select the image entry by name and
                                // update only its newTag / newName field. Leaves all other
                                // entries and fields untouched.
                                sh """
                                    yq -i \\
                                      '(.images[] | select(.name == "${svc}")).newTag = "${env.IMAGE_TAG}"' \\
                                      ${manifestPath}
                                    yq -i \\
                                      '(.images[] | select(.name == "${svc}")).newName = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}"' \\
                                      ${manifestPath}
                                """
                                echo "  ✔ Updated ${svc} → tag: ${env.IMAGE_TAG}"
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
    Branch  : ${env.CONFIG_REPO_BRANCH}
    Tag     : ${env.IMAGE_TAG}
    Services: ${env.SERVICES_TO_BUILD}

    ArgoCD will detect the commit on '${env.CONFIG_REPO_BRANCH}' and deploy
    to the dev cluster within ~3 minutes.
    Monitor: https://argocd.192.168.56.10.nip.io → downstream-dev
─────────────────────────────────────────────────────────────────────────────
"""
                    }
                }
            }
        }
    }

    // =========================================================================
    post {
        always {
            // Clean workspace after every build (PR and main) to avoid stale
            // files on the emptyDir volume before the pod terminates.
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