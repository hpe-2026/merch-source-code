@Library('jenkins-shared-library') _

def ALL_SERVICES = [
    "frontend"             : "services/frontend",
    "node-backend"         : "services/node-backend",
    "python-service"       : "services/python-service",
    "merchant-portal"      : "services/merchant-portal",
    "notification-service" : "services/notification-service",
    "admin-dashboard"      : "services/admin-dashboard"
]

pipeline {
    agent {
        kubernetes {
            defaultContainer 'devops'
            yaml getMerchPodYaml()
        }
    }

    options {
        skipDefaultCheckout()
        timestamps()
        disableConcurrentBuilds()
    }

    environment {
        NEXUS_REGISTRY = '192.168.56.10:30082'
        CONFIG_REPO_DIR = 'hpe-merch-config'
        GITHUB_CRED_ID = 'github-pat'
    }

    stages {
        stage('Checkout & Setup') {
            steps {
                script {
                    env.IS_PR   = (env.CHANGE_ID != null) ? 'true' : 'false'
                    env.IS_MAIN = (env.BRANCH_NAME == 'main') ? 'true' : 'false'

                    checkout scm

                    sh 'git config --global --add safe.directory "*"'
                }
            }
        }

        stage('Detect Changed Services') {
            steps {
                script {
                    def changedSet = [] as Set
                    def fetchBranch = env.IS_PR == 'true' ? env.CHANGE_TARGET : 'main'
                    sh "git fetch origin +refs/heads/${fetchBranch}:refs/remotes/origin/${fetchBranch} --depth=200 || true"

                    def diffOut = ""
                    if (env.IS_PR == 'true') {
                        def mergeBase = sh(script: "git merge-base origin/${fetchBranch} HEAD || echo HEAD", returnStdout: true).trim()
                        diffOut = sh(script: "git diff --name-only ${mergeBase}...HEAD || true", returnStdout: true).trim()
                    } else {
                        diffOut = sh(script: "git diff --name-only HEAD~1...HEAD || true", returnStdout: true).trim()
                    }

                    diffOut.split('\n').each { filePath ->
                        if (!filePath.trim()) return
                        def parts = filePath.tokenize('/')
                        if (parts.size() >= 2 && parts[0] == 'services') {
                            if (ALL_SERVICES.containsKey(parts[1])) {
                                changedSet << parts[1]
                            }
                        }
                    }

                    if (changedSet.isEmpty()) {
                        echo "No specific service changes detected. Building all services just in case."
                        changedSet = ALL_SERVICES.keySet() as Set
                    }

                    env.SERVICES_TO_BUILD = changedSet.join(',')
                    echo "Services to build: ${env.SERVICES_TO_BUILD}"
                }
            }
        }

        stage('Lint & Unit Test') {
            steps {
                script {
                    def testFailed = false
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        def svcPath = ALL_SERVICES[svc.trim()]
                        dir(svcPath) {
                            def result = sh(
                                script: """
                                    if [ -f package.json ]; then
                                        npm ci --prefer-offline --legacy-peer-deps
                                        npm run lint --if-present || true

                                        if grep -q '"vitest"' package.json; then
                                            npm test
                                        else
                                            npm test -- --ci --reporters=default --reporters=jest-junit
                                        fi
                                    elif [ -f requirements.txt ]; then
                                        python3 -m venv .venv
                                        . .venv/bin/activate
                                        pip install -r requirements.txt
                                        python3 -m pytest --junitxml=test-results.xml
                                    fi
                                """,
                                returnStatus: true
                            )
                            if (result != 0) testFailed = true
                        }
                    }
                    if (testFailed) {
                        error("One or more unit tests failed. Aborting pipeline.")
                    }
                }
            }
            post {
                always {
                    junit allowEmptyResults: true, testResults: '**/test-results.xml,**/junit.xml'
                }
            }
        }

        stage('Security Scan (Trivy)') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        def svcPath = ALL_SERVICES[svc.trim()]
                        container('security') {
                            echo "Running Trivy FS scan on ${svc}"
                            sh "trivy fs --severity HIGH,CRITICAL --exit-code 1 --no-progress ${svcPath}"
                        }
                    }
                }
            }
        }

        stage('Generate Image Tag') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    env.IMAGE_TAG = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    echo "Planned image tag: ${env.IMAGE_TAG}"
                }
            }
        }

        stage('Kaniko Build & Push') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        def svcPath  = ALL_SERVICES[svc.trim()]
                        def imageRef = "${env.NEXUS_REGISTRY}/merch-docker/${svc.trim()}:${env.IMAGE_TAG}"

                        container('kaniko') {
                            sh """
                                /kaniko/executor \\
                                  --context="${WORKSPACE}/${svcPath}" \\
                                  --dockerfile="${WORKSPACE}/${svcPath}/Dockerfile" \\
                                  --destination="${imageRef}" \\
                                  --insecure \\
                                  --insecure-pull \\
                                  --skip-tls-verify \\
                                  --insecure-registry="${env.NEXUS_REGISTRY}"
                            """
                        }
                    }
                }
            }
        }

        stage('GitOps Config Update') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID, usernameVariable: 'GIT_USER', passwordVariable: 'GIT_PASS')]) {
                    sh """
                        git config --global user.email "jenkins@nitte.edu"
                        git config --global user.name  "Jenkins Automation"

                        rm -rf ${env.CONFIG_REPO_DIR}
                        git clone https://${GIT_USER}:${GIT_PASS}@github.com/hpe-2026/hpe-merch-config.git ${env.CONFIG_REPO_DIR}
                    """
                    script {
                        env.SERVICES_TO_BUILD.split(',').each { svc ->
                            sh """
                                cd ${env.CONFIG_REPO_DIR}/downstream-clusters/base
                                yq eval -i '.images |= map(select(.name == "'${svc.trim()}'").newTag = "'${env.IMAGE_TAG}'" // .)' kustomization.yaml
                            """
                        }
                    }
                    sh """
                        cd ${env.CONFIG_REPO_DIR}
                        git add .
                        git commit -m "chore: deploy commit ${env.IMAGE_TAG}" || true
                        git push origin main
                    """
                }
            }
        }
    }

    post {
        cleanup {
            cleanWs()
        }
    }
}
