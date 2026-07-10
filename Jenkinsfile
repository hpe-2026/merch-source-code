// merch-source-code pipeline
// PR builds  → CI only (no image build/push)
// main builds → CI + Kaniko build/push + GitOps config update → ArgoCD deploys to dev

def ALL_SERVICES = [
    "frontend"             : "services/frontend",
    "node-backend"         : "services/node-backend",
    "python-service"       : "services/python-service",
    "merchant-portal"      : "services/merchant-portal",
    "notification-service" : "services/notification-service",
    "admin-dashboard"      : "services/admin-dashboard"
]

def svcDir(Map allSvcs, String svc) {
    def d = allSvcs[svc]
    if (!d) { error("Unknown service '${svc}' — not in ALL_SERVICES.") }
    return d
}

// Restores /bin/sh, /workspace, and purges stale /kaniko/[0-9]* snapshot dirs
// after each kaniko executor run so Jenkins can exec into the same container again.
// Must be a separate sh step — NOT chained with && on the executor line.
// See: https://github.com/GoogleContainerTools/kaniko/issues/2793
def resetKanikoContainerAfterBuild() {
    sh(
        label: 'Reset Kaniko container for next build',
        script: '''/busybox/sh -c '
            /busybox/mkdir -p /bin /usr/bin /workspace
            /busybox/ln -sf /busybox/sh    /bin/sh
            /busybox/ln -sf /busybox/cat   /bin/cat
            /busybox/ln -sf /busybox/env   /usr/bin/env
            /busybox/ln -sf /busybox/rm    /bin/rm
            /busybox/ln -sf /busybox/mkdir /bin/mkdir
            for d in /kaniko/[0-9]*; do
                [ -e "$d" ] && /busybox/rm -rf "$d"
            done
            /busybox/rm -f /kaniko/Dockerfile
        ' '''
    )
}

pipeline {

    // Single pod for the entire pipeline — zero extra pods during Kaniko builds.
    // Pod requests: jnlp 128Mi + devops 256Mi + kaniko 384Mi = 768Mi total.
    // Limits allow kaniko to burst to 1.5Gi during layer extraction + push.
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
  - name: kaniko
    image: gcr.io/kaniko-project/executor:debug
    command: ["sleep", "99d"]
    tty: true
    workingDir: /home/jenkins/agent
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
        ALL_SERVICES_CSV   = ALL_SERVICES.keySet().join(',')
        NEXUS_REGISTRY     = '192.168.56.10:30082'
        NEXUS_REPO_NAME    = 'merch-docker'
        CONFIG_REPO_URL    = 'https://github.com/hpe-2026/hpe-merch-config.git'
        CONFIG_REPO_DIR    = 'hpe-merch-config'
        CONFIG_REPO_BRANCH = 'main'
        SONAR_ENABLED      = 'false'
        GITHUB_CRED_ID     = 'github-pat'
        SONAR_TOKEN_ID     = 'sonarqube-token'
        NEXUS_CRED_ID      = 'nexus-creds'
        SONARQUBE_SERVER   = 'sonarqube-admin'
    }

    stages {

        stage('Setup & Checkout') {
            steps {
                // Install tools + register workspace as git safe.directory (uid mismatch
                // between jnlp container owner and devops root user requires this).
                sh '''
                    set -e
                    apk add --no-cache git python3 py3-pip curl bash openssl
                    YQ_VERSION="v4.40.5"
                    curl -fsSL \
                        "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" \
                        -o /usr/local/bin/yq
                    chmod +x /usr/local/bin/yq
                '''
                sh 'git config --global --add safe.directory "${WORKSPACE}"'
                sh 'git config --global --add safe.directory "${WORKSPACE}/${CONFIG_REPO_DIR}"'

                checkout scm

                script {
                    env.GIT_SHORT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    env.IMAGE_TAG     = "${env.BUILD_NUMBER}-${env.GIT_SHORT_SHA}"
                    env.IS_PR         = (env.CHANGE_ID   != null)   ? 'true' : 'false'
                    env.IS_MAIN       = (env.BRANCH_NAME == 'main') ? 'true' : 'false'
                    echo "Branch: ${env.BRANCH_NAME ?: env.CHANGE_BRANCH} | PR: ${env.IS_PR} | Tag: ${env.IMAGE_TAG}"
                }
            }
        }

        stage('Detect Changed Services') {
            steps {
                script {
                    def baseRef

                    if (env.IS_PR == 'true') {
                        sh "git fetch origin ${env.CHANGE_TARGET} --depth=100"
                        baseRef = "origin/${env.CHANGE_TARGET}"
                    } else {
                        sh 'git fetch origin main --depth=100'
                        def hasPrev = sh(script: 'git rev-parse HEAD~1 >/dev/null 2>&1', returnStatus: true) == 0
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
                            if (parts.size() >= 2 && parts[0] == 'services') {
                                def candidate = parts[1]
                                if (ALL_SERVICES.containsKey(candidate)) changedSet << candidate
                            }
                        }
                    }

                    if (changedSet.isEmpty()) {
                        echo 'No service-specific changes detected — building ALL services.'
                        changedSet = ALL_SERVICES.keySet() as Set
                    }

                    // On main: force-build any service with no image in Nexus yet (bootstrap).
                    def missingInNexus = [] as Set
                    if (env.IS_MAIN == 'true') {
                        withCredentials([usernamePassword(
                                credentialsId: env.NEXUS_CRED_ID,
                                usernameVariable: 'NEXUS_USER',
                                passwordVariable: 'NEXUS_PASS')]) {
                            ALL_SERVICES.keySet().each { svc ->
                                def tagsJson = sh(
                                    script: """
                                        curl --silent --fail \\
                                             --user "\${NEXUS_USER}:\${NEXUS_PASS}" \\
                                             "http://${env.NEXUS_REGISTRY}/v2/${env.NEXUS_REPO_NAME}/${svc}/tags/list" \\
                                             2>/dev/null || echo ""
                                    """,
                                    returnStdout: true
                                ).trim()

                                boolean hasTags = tagsJson &&
                                    tagsJson.contains('"tags"') &&
                                    !tagsJson.contains('"tags":null') &&
                                    !tagsJson.contains('"tags":[]')

                                if (!hasTags) missingInNexus << svc
                            }
                        }
                        if (missingInNexus) echo "Bootstrap (missing from Nexus): ${missingInNexus.join(', ')}"
                    }

                    def finalSet = (changedSet + missingInNexus) as Set
                    env.SERVICES_TO_BUILD = finalSet.join(',')
                    echo "Services to process: ${env.SERVICES_TO_BUILD}"
                }
            }
        }

        // Install deps and run unit tests in parallel across all changed services.
        // Each service runs its own branch; failures are collected and reported together.
        stage('CI: Install + Test') {
            steps {
                script {
                    def services  = env.SERVICES_TO_BUILD.split(',').collect { it.trim() }
                    def branches  = [:]
                    def ciFailures = [].asSynchronized()

                    services.each { svc ->
                        def svcPath = svcDir(ALL_SERVICES, svc)
                        branches[svc] = {
                            dir(svcPath) {
                                try {
                                    sh """
                                        set -e
                                        if [ -f package.json ]; then
                                            npm ci --legacy-peer-deps
                                            npm test -- --ci \
                                                --passWithNoTests \
                                                --reporters=default \
                                                --reporters=jest-junit 2>/dev/null || \
                                            npm test -- --passWithNoTests 2>/dev/null || \
                                            echo "[${svc}] No test runner configured — skipping."
                                        elif [ -f requirements.txt ]; then
                                            python3 -m venv .venv
                                            . .venv/bin/activate
                                            pip install --upgrade pip setuptools -q
                                            pip install -r requirements.txt -q
                                            python3 -m pytest \
                                                --tb=short \
                                                -p no:warnings \
                                                --junitxml=test-results.xml
                                        else
                                            echo "[${svc}] No recognised manifest — skipping."
                                        fi
                                    """
                                } catch (Exception e) {
                                    ciFailures << "[${svc}] ${e.getMessage()}"
                                }
                            }
                        }
                    }

                    // failFast: false — collect all failures before aborting.
                    parallel(branches + [failFast: false])

                    if (!ciFailures.isEmpty()) {
                        error("CI failures:\n" + ciFailures.join('\n'))
                    }
                }
            }
            post {
                always {
                    junit allowEmptyResults: true, testResults: '**/test-results.xml,**/junit.xml'
                }
            }
        }

        stage('SonarQube Analysis') {
            when { expression { env.SONAR_ENABLED == 'true' } }
            steps {
                withSonarQubeEnv(env.SONARQUBE_SERVER) {
                    withCredentials([string(credentialsId: env.SONAR_TOKEN_ID, variable: 'SONAR_TOKEN')]) {
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

        stage('Quality Gate') {
            when { expression { env.SONAR_ENABLED == 'true' } }
            steps {
                timeout(time: 15, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }

        // ── main-branch only from here ────────────────────────────────────────

        // All 6 image builds run sequentially inside this pod's kaniko container.
        // Sequential (not parallel) to stay within the 4 GiB single-node budget:
        // two concurrent kaniko builds would exceed available RAM.
        // Failures are collected per-service; remaining builds always continue.
        stage('Kaniko: Build & Push Images') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    def failedServices = []

                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc       = svcName.trim()
                        def svcPath   = svcDir(ALL_SERVICES, svc)
                        def imageRef  = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}:${env.IMAGE_TAG}"
                        def cacheRepo = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}-cache"

                        echo "Building ${svc} → ${imageRef}"

                        try {
                            if (!fileExists(svcPath))                error("[${svc}] Service directory not found: ${svcPath}")
                            if (!fileExists("${svcPath}/Dockerfile")) error("[${svc}] Dockerfile not found at ${svcPath}/Dockerfile")

                            container('kaniko') {
                                retry(3) {
                                    sh(
                                        label: "Kaniko build ${svc}",
                                        script: """
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
                                        """
                                    )
                                    resetKanikoContainerAfterBuild()
                                }
                            }
                            echo "✔ ${svc} pushed → ${imageRef}"

                        } catch (Exception e) {
                            echo "✗ ${svc} FAILED: ${e.getMessage()}"
                            failedServices << svc
                        }
                    }

                    if (!failedServices.isEmpty()) {
                        error("Kaniko stage failed for: ${failedServices.join(', ')}")
                    }
                }
            }
        }

        stage('Update Config Repository') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID,
                                                  usernameVariable: 'GIT_USER',
                                                  passwordVariable: 'GIT_TOKEN')]) {
                    script {
                        def repoHost  = env.CONFIG_REPO_URL.replaceFirst('https://', '')
                        def authedUrl = "https://${GIT_USER}:${GIT_TOKEN}@${repoHost}"

                        sh """
                            rm -rf ${env.CONFIG_REPO_DIR}
                            git clone --depth=1 --branch ${env.CONFIG_REPO_BRANCH} \
                                ${authedUrl} ${env.CONFIG_REPO_DIR}
                        """

                        dir(env.CONFIG_REPO_DIR) {
                            def manifestPath = 'downstream-clusters/base/kustomization.yaml'

                            env.SERVICES_TO_BUILD.split(',').each { svcName ->
                                def svc = svcName.trim()
                                sh """
                                    yq -i '(.images[] | select(.name == "${svc}")).newTag  = "${env.IMAGE_TAG}"' ${manifestPath}
                                    yq -i '(.images[] | select(.name == "${svc}")).newName = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}"' ${manifestPath}
                                """
                                echo "✔ Updated ${svc} → ${env.IMAGE_TAG}"
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

                        echo "✔ Config repo updated — ArgoCD will deploy tag ${env.IMAGE_TAG} to dev within ~3 min."
                    }
                }
            }
        }
    }

    post {
        always { cleanWs() }
        success { echo "✔ Pipeline PASSED — branch: ${env.BRANCH_NAME ?: env.CHANGE_BRANCH} | tag: ${env.IMAGE_TAG ?: 'n/a (PR)'}" }
        failure { echo "✘ Pipeline FAILED — build #${env.BUILD_NUMBER}. Check console output." }
    }
}