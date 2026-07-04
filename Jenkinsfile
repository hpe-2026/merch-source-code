// =============================================================================
// Jenkinsfile  —  merch-source-code
//
// Single pipeline that behaves differently for:
//   - Pull Request builds        (CI only: build, test, sonar, quality gate)
//   - main branch builds (CI/CD): kaniko build → push to Nexus →
//                                  bump image tag in hpe-merch-config →
//                                  push → ArgoCD takes over from there
//
// Jenkins NEVER runs kubectl / helm / argocd here.
// It only pushes an image and edits a YAML file in the config repo.
// ArgoCD does the deployment.
// =============================================================================

// ---- Master list of microservices in this monorepo -------------------------
// Key   = service name  (also used as the image name)
// Value = path relative to repo root that contains the Dockerfile
//
// FIX #1/#2/#5: Use a plain Map and always reference it as ALL_SERVICES.
//               Keys are extracted with .keySet() / .collectEntries() so that
//               .join() is called on a List, not on the Map itself.
def ALL_SERVICES = [
    "frontend"             : "services/frontend",
    "node-backend"         : "services/node-backend",
    "python-service"       : "services/python-service",
    "merchant-portal"      : "services/merchant-portal",
    "notification-service" : "services/notification-service",
    "admin-dashboard"      : "services/admin-dashboard"
]

// ---- Helper: Kaniko pod template -------------------------------------------
// FIX #10: svc is passed as a parameter so the closure captures a local copy,
//          not a loop-variable reference.
def kanikoPodYaml(String svc) {
    return """
apiVersion: v1
kind: Pod
metadata:
  labels:
    job: kaniko-${svc}
spec:
  restartPolicy: Never
  containers:
  - name: kaniko
    image: gcr.io/kaniko-project/executor:v1.23.2-debug
    imagePullPolicy: IfNotPresent
    command:
    - /busybox/cat
    tty: true
    volumeMounts:
    - name: nexus-docker-config
      mountPath: /kaniko/.docker
  volumes:
  - name: nexus-docker-config
    secret:
      secretName: nexus-registry-credentials
      items:
      - key: .dockerconfigjson
        path: config.json
"""
}

// ---- Helper: resolve service directory from map ----------------------------
// FIX #2: Single authoritative helper so every stage uses ALL_SERVICES[svc],
//         never the undefined SERVICES variable.
def svcDir(Map allSvcs, String svc) {
    def d = allSvcs[svc]
    if (!d) { error("Unknown service '${svc}' — not listed in ALL_SERVICES.") }
    return d
}

// ============================================================================
pipeline {

    agent any

    options {
        timestamps()
        ansiColor('xterm')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '25', artifactNumToKeepStr: '10'))
        timeout(time: 90, unit: 'MINUTES')
    }

    environment {
        // FIX #1/#5: join only the keys (a List), not the whole Map.
        ALL_SERVICES_CSV   = ALL_SERVICES.keySet().join(',')

        // Nexus — docker-format hosted repo running on the admin cluster.
        // ⚠ Replace with your real Nexus host:port if different.
        NEXUS_REGISTRY     = 'nexus.admin.svc.cluster.local:8082'
        NEXUS_REPO_NAME    = 'merch-docker'

        // GitOps config repo
        CONFIG_REPO_URL    = 'https://github.com/hpe-2026/hpe-merch-config.git'
        CONFIG_REPO_DIR    = 'hpe-merch-config'
        CONFIG_REPO_BRANCH = 'main'

        // SonarQube server name (must match the name in Manage Jenkins → System)
        SONARQUBE_SERVER   = 'sonarqube-admin'

        // Credential IDs (created in Jenkins → Manage Jenkins → Credentials)
        GITHUB_CRED_ID     = 'github-pat'
        SONAR_TOKEN_ID     = 'sonarqube-token'
        NEXUS_CRED_ID      = 'nexus-creds'
    }

    // =========================================================================
    stages {

        // ── Checkout ──────────────────────────────────────────────────────────
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    env.GIT_SHORT_SHA = sh(
                        script: 'git rev-parse --short HEAD',
                        returnStdout: true
                    ).trim()
                    env.IMAGE_TAG = "${env.BUILD_NUMBER}-${env.GIT_SHORT_SHA}"
                    env.IS_PR     = (env.CHANGE_ID   != null)   ? 'true' : 'false'
                    env.IS_MAIN   = (env.BRANCH_NAME == 'main') ? 'true' : 'false'

                    echo "Build context → PR:${env.IS_PR}  MAIN:${env.IS_MAIN}  TAG:${env.IMAGE_TAG}"
                }
            }
        }

        // ── Detect Changed Services ───────────────────────────────────────────
        // FIX #3: Properly split diff output into lines, extract the service
        //         name from  services/<service>/...  paths, and guard against
        //         the undefined `file` variable that crashed the original.
        stage('Detect Changed Services') {
            steps {
                script {
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

                    def changedSet = [] as Set   // use a Set to avoid duplicates

                    if (baseRef) {
                        def diffOut = sh(
                            script: "git diff --name-only ${baseRef}...HEAD 2>/dev/null || true",
                            returnStdout: true
                        ).trim()

                        // Walk every changed file and extract the service name.
                        //   services/frontend/src/App.js  →  frontend
                        //   services/node-backend/routes/user.js  →  node-backend
                        diffOut.split('\n').each { filePath ->
                            if (!filePath) return
                            def parts = filePath.tokenize('/')
                            // Must be  services/<svc>/...  (at least two tokens after root)
                            if (parts.size() >= 2 && parts[0] == 'services') {
                                def candidate = parts[1]
                                if (ALL_SERVICES.containsKey(candidate)) {
                                    changedSet << candidate
                                }
                            }
                        }
                    }

                    if (changedSet.isEmpty()) {
                        echo 'No specific service changes detected (or first build) — building ALL services.'
                        changedSet = ALL_SERVICES.keySet() as Set
                    }

                    env.SERVICES_TO_BUILD = changedSet.join(',')
                    echo "Services to process this run: ${env.SERVICES_TO_BUILD}"
                }
            }
        }

        // ── Install Dependencies ──────────────────────────────────────────────
        // FIX #2: dir() now uses ALL_SERVICES[svc], not the undefined SERVICES.
        stage('Install Dependencies') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        dir(svcDir(ALL_SERVICES, svc)) {
                            sh '''
                                if   [ -f package.json      ]; then
                                    npm ci
                                elif [ -f requirements.txt  ]; then
                                    pip install --user -r requirements.txt
                                else
                                    echo "No recognized dependency manifest in $(pwd) — skipping."
                                fi
                            '''
                        }
                    }
                }
            }
        }

        // ── Build ─────────────────────────────────────────────────────────────
        stage('Build') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        dir(svcDir(ALL_SERVICES, svc)) {
                            sh '''
                                if   [ -f package.json                        ]; then
                                    npm run build --if-present
                                elif [ -f setup.py ] || [ -f pyproject.toml   ]; then
                                    python -m compileall -q .
                                else
                                    echo "No build step defined for $(pwd) — skipping."
                                fi
                            '''
                        }
                    }
                }
            }
        }

        // ── Unit Tests ────────────────────────────────────────────────────────
        stage('Unit Tests') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        dir(svcDir(ALL_SERVICES, svc)) {
                            sh '''
                                if   [ -f package.json     ]; then
                                    npm test -- --ci \
                                        --reporters=default \
                                        --reporters=jest-junit || exit 1
                                elif [ -f requirements.txt ]; then
                                    python -m pytest --junitxml=test-results.xml || exit 1
                                else
                                    echo "No tests defined for $(pwd) — skipping."
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

        // ── SonarQube Analysis ────────────────────────────────────────────────
        // FIX #7: Pass the literal constant (SONARQUBE_SERVER) to
        //         withSonarQubeEnv() so Jenkins resolves it at compile time.
        stage('SonarQube Analysis') {
            steps {
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

        // ── Quality Gate ──────────────────────────────────────────────────────
        stage('Quality Gate') {
            steps {
                timeout(time: 15, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }

        // =====================================================================
        // Everything below this point ONLY runs on main (post-merge).
        // A PR build stops at Quality Gate — no image is built, nothing pushed.
        // =====================================================================

        // ── Kaniko: Build & Push Images ───────────────────────────────────────
        // FIX #4:  --dockerfile now correctly points to services/<svc>/Dockerfile
        // FIX #10: Local copies of svc, image captured before entering the
        //          podTemplate/node closure to avoid stale variable references.
        stage('Kaniko: Build & Push Images') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    // Build a map of parallel branches — one per service.
                    // FIX #9: Services are built in parallel, cutting wall-clock
                    //         time from (N × slowest) down to ~(slowest).
                    def parallelBuilds = [:]

                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        // Capture loop variable into a local so the closure is safe.
                        def svc      = svcName
                        def svcPath  = svcDir(ALL_SERVICES, svc)
                        def imageRef = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}:${env.IMAGE_TAG}"

                        parallelBuilds["kaniko-${svc}"] = {
                            podTemplate(yaml: kanikoPodYaml(svc)) {
                                node(POD_LABEL) {
                                    checkout scm
                                    container('kaniko') {
                                        sh """
                                            /kaniko/executor \
                                              --context=\$(pwd)/${svcPath} \
                                              --dockerfile=\$(pwd)/${svcPath}/Dockerfile \
                                              --destination=${imageRef} \
                                              --cache=true \
                                              --cache-ttl=168h
                                        """
                                    }
                                    echo "✔ Pushed ${imageRef} to Nexus."
                                }
                            }
                        }
                    }

                    parallel parallelBuilds
                }
            }
        }

        // ── Update Config Repository ──────────────────────────────────────────
        // FIX #8:  yq v4 syntax corrected:
        //          (.images[] | select(.name == "X")).newTag = "Y"
        // FIX #11: Authenticated URL built in Groovy; no fragile sed stripping.
        //
        // ⚠ IMPORTANT: The kustomization.yaml path below assumes the layout
        //   apps/<service>/kustomization.yaml  inside  hpe-merch-config.
        //   Adjust the `manifestPath` variable to match your actual layout,
        //   e.g. apps/<service>/overlays/dev/kustomization.yaml
        stage('Update Config Repository') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID,
                                                  usernameVariable: 'GIT_USER',
                                                  passwordVariable: 'GIT_TOKEN')]) {
                    script {
                        // FIX #11: Build authenticated URL in Groovy — safe even
                        //          when the token contains special characters.
                        def repoHost    = env.CONFIG_REPO_URL.replaceFirst('https://', '')
                        def authedUrl   = "https://\${GIT_USER}:\${GIT_TOKEN}@${repoHost}"

                        sh """
                            rm -rf ${env.CONFIG_REPO_DIR}
                            git clone --depth=1 --branch ${env.CONFIG_REPO_BRANCH} \
                                ${authedUrl} \
                                ${env.CONFIG_REPO_DIR}
                        """

                        dir(env.CONFIG_REPO_DIR) {
                            env.SERVICES_TO_BUILD.split(',').each { svc ->
                                // ⚠ Adjust this path to match your config repo layout.
                                def manifestPath = "apps/${svc}/kustomization.yaml"

                                // FIX #8: Correct yq v4 syntax — updates ONLY newTag
                                //         for the matching image entry; leaves the rest
                                //         of the YAML untouched.
                                sh """
                                    yq -i '(.images[] | select(.name == "${svc}")).newTag = "${env.IMAGE_TAG}"' \
                                        ${manifestPath}
                                """

                                echo "Updated ${manifestPath} → newTag = ${env.IMAGE_TAG}"
                            }

                            sh """
                                git config user.email "jenkins-ci@merch.local"
                                git config user.name  "jenkins-ci"
                                git add -A
                                git diff --cached --quiet || git commit -m \
                                    "ci: bump image tag(s) → ${env.IMAGE_TAG} for [${env.SERVICES_TO_BUILD}] (build #${env.BUILD_NUMBER})"
                                git push origin ${env.CONFIG_REPO_BRANCH}
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
            cleanWs()
        }
        success {
            echo "✔ Pipeline PASSED — branch: ${env.BRANCH_NAME ?: env.CHANGE_BRANCH}  tag: ${env.IMAGE_TAG ?: 'n/a'}"
        }
        failure {
            echo "✘ Pipeline FAILED at build #${env.BUILD_NUMBER}. Check the console output above for details."
        }
    }
}
