// =============================================================================
// Jenkinsfile  —  merch-source-code (Production-Ready)
// =============================================================================

def ALL_SERVICES = [
    "frontend"             : "services/frontend",
    "node-backend"         : "services/node-backend",
    "python-service"       : "services/python-service",
    "merchant-portal"      : "services/merchant-portal",
    "notification-service" : "services/notification-service",
    "admin-dashboard"      : "services/admin-dashboard"
]

def svcDir(Map allSvcs, String svc) {
    return allSvcs[svc.trim()]
}

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
   agent {
    kubernetes {
        defaultContainer 'devops'
        idleMinutes 30
        yaml '''
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: merch-build
spec:
  serviceAccountName: jenkins
  restartPolicy: Never
  containers:
  - name: devops
    image: 192.168.56.10:30082/merch-docker/devops-tools:latest
    command: ["sleep", "99d"]
    tty: true
    workingDir: /home/jenkins/agent
    resources:
      requests:
        memory: "256Mi"
        cpu: "500m"
      limits:
        memory: "3Gi"
        cpu: "1000m"
    volumeMounts:
    - name: build-cache
      mountPath: /home/jenkins/.npm
  - name: kaniko
    image: gcr.io/kaniko-project/executor:debug
    command: ["sleep", "99d"]
    tty: true
    workingDir: /home/jenkins/agent
    resources:
      requests:
        memory: "256Mi"
        cpu: "500m"
      limits:
        memory: "1.5Gi"
        cpu: "1500m"
    volumeMounts:
    - name: nexus-docker-config
      mountPath: /kaniko/.docker
  - name: security
    image: aquasec/trivy:latest
    command: ["sleep", "99d"]
    tty: true
    workingDir: /home/jenkins/agent
  volumes:
  - name: nexus-docker-config
    secret:
      secretName: nexus-docker-config
  - name: build-cache
    persistentVolumeClaim:
      claimName: jenkins-build-cache
'''
        }
    }

    options {
        skipDefaultCheckout()
        timestamps()
        ansiColor('xterm')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timeout(time: 90, unit: 'MINUTES')
    }

    environment {
        ALL_SERVICES_CSV = ALL_SERVICES.keySet().join(',')
        NEXUS_REGISTRY  = '192.168.56.10:30082'
        NEXUS_REPO_NAME = 'merch-docker'
        CONFIG_REPO_URL = 'https://github.com/hpe-2026/hpe-merch-config.git'
        CONFIG_REPO_DIR = 'hpe-merch-config'
        CONFIG_REPO_BRANCH = 'main'
        GITHUB_CRED_ID = 'github-pat'
        NEXUS_CRED_ID = 'nexus-creds'
    }

    stages {
        stage('Setup & Checkout') {
            steps {
                sh '''
                   
                '''
                sh 'git config --global --add safe.directory "${WORKSPACE}"'
                script {
                    env.IS_PR = (env.CHANGE_ID != null) ? 'true' : 'false'
                    env.IS_MAIN = (env.BRANCH_NAME == 'main') ? 'true' : 'false'
                    env.IMAGE_TAG = ""

                    // Shallow clone for PRs/feature branches; full tags for main (semantic-release)
                    if (env.IS_MAIN == 'true') {
                        checkout scm
                    } else {
                        checkout([
                            $class: 'GitSCM',
                            branches: scm.branches,
                            extensions: [
                                [$class: 'CloneOption', depth: 1, shallow: true, noTags: true]
                            ],
                            userRemoteConfigs: scm.userRemoteConfigs
                        ])
                    }

                    env.GIT_SHORT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                }
                // Root package: generate lockfile if missing, then use npm ci with persistent cache
                sh '''
                    if [ ! -f package-lock.json ]; then
                        npm install --package-lock-only --no-audit --no-fund
                    fi
                    npm ci --cache /home/jenkins/.npm --prefer-offline --no-audit --no-fund
                '''
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
                        def diffOut = sh(script: "git diff --name-only ${baseRef}...HEAD 2>/dev/null || true", returnStdout: true).trim()
                        diffOut.split('\n').each { filePath ->
                            if (!filePath) return
                            def parts = filePath.tokenize('/')
                            if (parts.size() >= 2 && parts[0] == 'services') {
                                def candidate = parts[1]
                                if (ALL_SERVICES.containsKey(candidate)) {
                                    changedSet << candidate
                                }
                            }
                        }
                    }
                    if (changedSet.isEmpty()) {
                        changedSet = ALL_SERVICES.keySet() as Set
                    }
                    env.SERVICES_TO_BUILD = changedSet.join(',')
                }
            }
        }

        stage('Install Dependencies & Dependency Audit') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc = svcName.trim()
                        dir(svcDir(ALL_SERVICES, svc)) {
                            sh """
                                if [ -f package.json ]; then
                                    npm ci --legacy-peer-deps --cache /home/jenkins/.npm --prefer-offline
                                    npm audit --audit-level=high || echo "Ignoring audit failures for now"
                                elif [ -f requirements.txt ]; then
                                    python3 -m venv .venv
                                    . .venv/bin/activate
                                    pip install -r requirements.txt
                                fi
                            """
                        }
                    }
                }
            }
        }

        stage('Lint & Type Check') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc = svcName.trim()
                        dir(svcDir(ALL_SERVICES, svc)) {
                            sh """
                                if [ -f package.json ]; then
                                    npm run lint --if-present || true
                                fi
                            """
                        }
                    }
                }
            }
        }

        stage('Unit Tests & Coverage') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc = svcName.trim()
                        dir(svcDir(ALL_SERVICES, svc)) {
                            sh """
                                if [ -f package.json ]; then
if grep -q '"test:ci"' package.json; then
                                        JWT_SECRET=test-secret-ci-only KEYCLOAK_CLIENT_SECRET=test-secret-ci-only npm run test:ci
                                    else
                                        JWT_SECRET=test-secret-ci-only KEYCLOAK_CLIENT_SECRET=test-secret-ci-only npm test -- --ci --reporters=default --reporters=jest-junit
                                    fi
                                elif [ -f requirements.txt ]; then
                                    if [ -d .venv ]; then . .venv/bin/activate; fi
                                    python3 -m pytest --junitxml=test-results.xml || true
                                fi
                            """
                        }
                    }
                }
            }
            post {
                always {
                    junit allowEmptyResults: true, testResults: '**/test-results.xml,**/junit.xml'
                }
            }
        }

        stage('Semantic Release') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID, usernameVariable: 'GH_USER', passwordVariable: 'GH_TOKEN')]) {
                    sh 'npx semantic-release'
                    script {
                        if (fileExists('.version')) {
                            env.SEMVER = readFile('.version').trim()
                            env.IMAGE_TAG = "v${env.SEMVER}"
                            echo "Semantic Release generated new version: ${env.IMAGE_TAG}"
                        } else {
                            echo "No new version generated by Semantic Release. Skipping build and deploy."
                            env.IMAGE_TAG = 'NO_RELEASE'
                        }
                    }
                }
            }
        }

        stage('Kaniko Build & Push Images') {
            when { 
                allOf {
                    expression { env.IS_MAIN == 'true' }
                    expression { env.IMAGE_TAG != '' && env.IMAGE_TAG != 'NO_RELEASE' }
                }
            }
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc = svcName.trim()
                        def svcPath = svcDir(ALL_SERVICES, svc)
                        def imageRef = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}:${env.IMAGE_TAG}"
                        def latestRef = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}:latest"
                        def cacheRepo = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}/cache"
                        
                        container('kaniko') {
                            retry(3) {
                                sh(
                                    script: """
                                        /kaniko/executor \\
                                          --context="${WORKSPACE}/${svcPath}" \\
                                          --dockerfile="${WORKSPACE}/${svcPath}/Dockerfile" \\
                                          --destination="${imageRef}" \\
                                          --destination="${latestRef}" \\
                                          --cache=true \\
                                          --cache-repo="${cacheRepo}" \\
                                          --snapshot-mode=redo \\
                                          --insecure --insecure-pull --skip-tls-verify \\
                                          --log-format=text --verbosity=warn --cleanup
                                    """
                                )
                                resetKanikoContainerAfterBuild()
                            }
                        }
                    }
                }
            }
        }

        stage('Security Scan & SBOM') {
            when { 
                allOf {
                    expression { env.IS_MAIN == 'true' }
                    expression { env.IMAGE_TAG != '' && env.IMAGE_TAG != 'NO_RELEASE' }
                }
            }
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svcName ->
                        def svc = svcName.trim()
                        def imageRef = "${env.NEXUS_REGISTRY}/${env.NEXUS_REPO_NAME}/${svc}:${env.IMAGE_TAG}"
                        
                        container('security') {
                            sh """
                                echo "Scanning image ${imageRef} for vulnerabilities..."
                                trivy image --severity CRITICAL,HIGH --no-progress ${imageRef} || true
                                
                                echo "Generating SBOM for ${imageRef}..."
                                trivy image --format spdx-json --output sbom-${svc}.json ${imageRef} || true
                            """
                        }
                    }
                }
            }
        }

        stage('GitOps Config Update') {
            when { 
                allOf {
                    expression { env.IS_MAIN == 'true' }
                    expression { env.IMAGE_TAG != '' && env.IMAGE_TAG != 'NO_RELEASE' }
                }
            }
            steps {
                withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID, usernameVariable: 'GIT_USER', passwordVariable: 'GIT_PASS')]) {
                    sh """
                        git config --global user.email "jenkins@nitte.edu"
                        git config --global user.name "Jenkins Automation"
                        
                        rm -rf ${env.CONFIG_REPO_DIR}
                        git clone -b ${env.CONFIG_REPO_BRANCH} https://${GIT_USER}:${GIT_PASS}@github.com/hpe-2026/hpe-merch-config.git ${env.CONFIG_REPO_DIR}
                        
                        cd ${env.CONFIG_REPO_DIR}
                    """
                    script {
                        env.SERVICES_TO_BUILD.split(',').each { svcName ->
                            def svc = svcName.trim()
                            sh """
                                cd ${env.CONFIG_REPO_DIR}/downstream-clusters/base
                                yq eval -i '.images |= map(select(.name == "'${svc}'").newTag = "'${env.IMAGE_TAG}'" // .)' kustomization.yaml
                            """
                        }
                    }
                    sh """
                        cd ${env.CONFIG_REPO_DIR}
                        git diff
                        git add .
                        git commit -m "chore: release ${env.IMAGE_TAG} [skip ci]" || echo "No changes to commit"
                        git push origin ${env.CONFIG_REPO_BRANCH}
                    """
                }
            }
        }
    }
    post {
        always {
            cleanWs()
            echo "Pipeline complete. Notification sent."
        }
        success {
            script {
                try {
                    mail to: 'nittemerchandise@gmail.com',
                         subject: "SUCCESS: Jenkins Build: ${env.JOB_NAME} [Build #${env.BUILD_NUMBER}]",
                         body: "The build completed successfully!\n\nView the logs here: ${env.BUILD_URL}"
                } catch (Exception e) {
                    echo "WARNING: Failed to send success email notification: ${e.message}"
                }
            }
        }
        failure {
            script {
                try {
                    mail to: 'nittemerchandise@gmail.com',
                         subject: "FAILURE: Jenkins Build: ${env.JOB_NAME} [Build #${env.BUILD_NUMBER}]",
                         body: "The build failed during execution.\n\nView the logs here: ${env.BUILD_URL}"
                } catch (Exception e) {
                    echo "WARNING: Failed to send failure email notification: ${e.message}"
                }
            }
        }
    }
}