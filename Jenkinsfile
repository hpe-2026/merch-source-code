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
        // The single entry point for all images via Group Repo routing
        NEXUS_REGISTRY = '192.168.56.10:30082'
        CONFIG_REPO_DIR = 'hpe-merch-config'
        GITHUB_CRED_ID = 'github-pat'
        OWNER_EMAIL = 'nittemerchandise@gmail.com'
    }

    stages {
        stage('Checkout & Setup') {
            steps {
                script {
                    env.IS_PR = (env.CHANGE_ID != null) ? 'true' : 'false'
                    env.IS_MAIN = (env.BRANCH_NAME == 'main') ? 'true' : 'false'
                    
                    checkout scm
                    
                    // Dynamically get the email of the developer who made the commit
                    env.COMMIT_AUTHOR_EMAIL = sh(script: "git log -1 --pretty=format:'%ae'", returnStdout: true).trim()
                }
            }
        }

        stage('Detect Changed Services') {
            steps {
                script {
                    def changedSet = [] as Set
                    def targetRef = env.IS_PR == 'true' ? "origin/${env.CHANGE_TARGET}" : "origin/main"
                    
                    sh "git fetch origin ${env.IS_PR == 'true' ? env.CHANGE_TARGET : 'main'} --depth=200 || true"
                    
                    def mergeBase = sh(script: "git merge-base ${targetRef} HEAD || echo HEAD", returnStdout: true).trim()
                    def diffOut = sh(script: "git diff --name-only ${mergeBase}...HEAD || true", returnStdout: true).trim()
                    
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
                                        npm ci --prefer-offline
                                        npm run lint --if-present || true
                                        npm test -- --ci --reporters=default --reporters=jest-junit || true
                                    elif [ -f requirements.txt ]; then
                                        python3 -m venv .venv
                                        . .venv/bin/activate
                                        pip install -r requirements.txt
                                        python3 -m pytest --junitxml=test-results.xml || true
                                    fi
                                """,
                                returnStatus: true
                            )
                            if (result != 0) testFailed = true
                        }
                    }
                    if (testFailed && env.IS_PR == 'true') {
                        error("Unit tests failed!")
                    }
                }
            }
            post {
                always {
                    // Jenkins will parse these into a visual dashboard
                    junit allowEmptyResults: true, testResults: '**/test-results.xml,**/junit.xml'
                }
            }
        }

        stage('Kaniko Build & Push (Main Only)') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    // Quick tag generation using git commit hash
                    env.IMAGE_TAG = "v1.0-${sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()}"
                    
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        def svcPath = ALL_SERVICES[svc.trim()]
                        
                        // Push routes to merch-docker via the Group Repo automatically!
                        def imageRef = "${env.NEXUS_REGISTRY}/merch-docker/${svc.trim()}:${env.IMAGE_TAG}"
                        
                        container('kaniko') {
                            sh """
                                /kaniko/executor \\
                                  --context="${WORKSPACE}/${svcPath}" \\
                                  --dockerfile="${WORKSPACE}/${svcPath}/Dockerfile" \\
                                  --destination="${imageRef}" \\
                                  --registry-mirror="${env.NEXUS_REGISTRY}" \\
                                  --insecure --insecure-pull --skip-tls-verify \\
                                  --insecure-registry="${env.NEXUS_REGISTRY}"
                            """
                        }
                    }
                }
            }
        }

        stage('GitOps Config Update (Main Only)') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID, usernameVariable: 'GIT_USER', passwordVariable: 'GIT_PASS')]) {
                    sh """
                        git config --global user.email "jenkins@nitte.edu"
                        git config --global user.name "Jenkins Automation"
                        
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
                        git commit -m "chore: deploy tag ${env.IMAGE_TAG} [skip ci]" || true
                        git push origin main
                    """
                }
            }
        }
    }

    post {
        always {
            cleanWs()
        }
        success {
            script {
                if (env.IS_PR == 'true') {
                    emailext subject: "SUCCESS: PR Build #${env.BUILD_NUMBER}",
                             body: "Your PR passed all CI checks!\n\n${env.BUILD_URL}",
                             to: env.COMMIT_AUTHOR_EMAIL
                } else {
                    emailext subject: "SUCCESS: Deployment #${env.BUILD_NUMBER}",
                             body: "Services (${env.SERVICES_TO_BUILD}) were built and deployed to Dev.\n\n${env.BUILD_URL}",
                             to: "${env.OWNER_EMAIL},${env.COMMIT_AUTHOR_EMAIL}"
                }
            }
        }
        failure {
            script {
                if (env.IS_PR == 'true') {
                    // Attach the XML files directly to the email for the developer!
                    emailext subject: "FAILURE: PR Build #${env.BUILD_NUMBER}",
                             body: "Your PR failed the CI checks. Please find the attached test results.\n\n${env.BUILD_URL}",
                             to: env.COMMIT_AUTHOR_EMAIL,
                             attachmentsPattern: '**/test-results.xml, **/junit.xml'
                } else {
                    emailext subject: "FAILURE: Deployment #${env.BUILD_NUMBER}",
                             body: "The deployment pipeline failed.\n\n${env.BUILD_URL}",
                             to: "${env.OWNER_EMAIL},${env.COMMIT_AUTHOR_EMAIL}"
                }
            }
        }
    }
}
