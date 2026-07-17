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
        // The single entry point for our internal images
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
                    sh 'git config --global --add safe.directory "*"'
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
                                        npm ci --prefer-offline --legacy-peer-deps
                                        npm run lint --if-present || true
                                        
                                        # Vitest does not accept --ci, so we handle it differently than Jest
                                        if grep -q '"vitest"' package.json; then
                                            npm test || true
                                        else
                                            npm test -- --ci --reporters=default --reporters=jest-junit || true
                                        fi
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
                    if (testFailed) {
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

        stage('Version Bump & Tag (Main Only)') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID, usernameVariable: 'GIT_USER', passwordVariable: 'GIT_PASS')]) {
                    script {
                        // 1. Read and bump version
                        if (!fileExists('version.txt')) {
                            writeFile file: 'version.txt', text: '1.0.0'
                            env.NEW_VERSION = '1.0.0'
                        } else {
                            def currentVersion = readFile('version.txt').trim()
                            def parts = currentVersion.split('\\.')
                            def major = parts[0]
                            def minor = parts[1]
                            def patch = parts[2].toInteger() + 1
                            env.NEW_VERSION = "${major}.${minor}.${patch}"
                            writeFile file: 'version.txt', text: env.NEW_VERSION
                        }

                        env.SHORT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                        env.IMAGE_TAG = "${env.NEW_VERSION}-${env.SHORT_SHA}"
                        env.GIT_TAG = "v${env.NEW_VERSION}"

                        // 2. Check if tag exists
                        def tagExists = sh(script: "git ls-remote --tags origin ${env.GIT_TAG} | grep ${env.GIT_TAG} || true", returnStdout: true).trim()
                        if (tagExists != '') {
                            error("Tag ${env.GIT_TAG} already exists. Failing to prevent overwrite.")
                        }

                        // 3. Commit version.txt and push tag
                        sh """
                            git config --global user.email "jenkins@nitte.edu"
                            git config --global user.name "Jenkins Automation"
                            
                            REPO_URL=\$(git config remote.origin.url | sed -e 's/.*github.com[:\\/]//' -e 's/\\.git\$//')
                            git remote set-url origin "https://${GIT_USER}:${GIT_PASS}@github.com/\${REPO_URL}.git"
                            
                            git add version.txt
                            git commit -m "chore: bump version to ${env.GIT_TAG}"
                            git tag ${env.GIT_TAG}
                            git push origin HEAD:main
                            git push origin ${env.GIT_TAG}
                        """
                    }
                }
            }
        }

        stage('Kaniko Build & Push (Main Only)') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    // env.IMAGE_TAG and env.GIT_TAG are generated in the Version Bump & Tag stage
                    
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        def svcPath = ALL_SERVICES[svc.trim()]
                        
                        // Push directly to merch-docker
                        def imageRef = "${env.NEXUS_REGISTRY}/merch-docker/${svc.trim()}:${env.IMAGE_TAG}"
                        
                        container('kaniko') {
                            sh """
                                /kaniko/executor \
                                  --context="${WORKSPACE}/${svcPath}" \
                                  --dockerfile="${WORKSPACE}/${svcPath}/Dockerfile" \
                                  --destination="${imageRef}" \
                                  --insecure \
                                  --insecure-pull \
                                  --skip-tls-verify \
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
                        git commit -m "chore: deploy release ${env.GIT_TAG}" || true
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
