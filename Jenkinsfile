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

        // ================================================================
        // STAGE 1 — CHECKOUT & SETUP
        // Runs for both PR builds and main merges.
        // Guards against infinite loops caused by Jenkins automation commits.
        // ================================================================
        stage('Checkout & Setup') {
            steps {
                script {
                    env.IS_PR   = (env.CHANGE_ID != null) ? 'true' : 'false'
                    env.IS_MAIN = (env.BRANCH_NAME == 'main') ? 'true' : 'false'

                    checkout scm

                    sh 'git config --global --add safe.directory "*"'

                    def commitMsg    = sh(script: 'git log -1 --pretty=%B || true', returnStdout: true).trim()
                    def commitAuthor = sh(script: 'git log -1 --pretty=format:"%an" || true', returnStdout: true).trim()

                    if (commitMsg.contains('[skip ci]') || commitAuthor == 'Jenkins Automation') {
                        currentBuild.result = 'NOT_BUILT'
                        error("Skipping build: Detected automated Jenkins commit to prevent loop.")
                    }
                }
            }
        }

        // ================================================================
        // STAGE 2 — DETECT CHANGED SERVICES
        // Runs for both PR builds and main merges.
        // Computes SERVICES_TO_BUILD by diffing against the target branch.
        // Falls back to all services if no service-specific changes are found.
        // ================================================================
        stage('Detect Changed Services') {
            steps {
                script {
                    def changedSet = [] as Set
                    def targetRef  = env.IS_PR == 'true' ? "origin/${env.CHANGE_TARGET}" : "origin/main"

                    def fetchBranch = env.IS_PR == 'true' ? env.CHANGE_TARGET : 'main'
                    sh "git fetch origin +refs/heads/${fetchBranch}:refs/remotes/origin/${fetchBranch} --depth=200 || true"

                    def diffOut = ""
                    if (env.IS_PR == 'true') {
                        def mergeBase = sh(script: "git merge-base origin/${fetchBranch} HEAD || echo HEAD", returnStdout: true).trim()
                        diffOut = sh(script: "git diff --name-only ${mergeBase}...HEAD || true", returnStdout: true).trim()
                    } else {
                        // On main, diff against the previous commit to see what just merged
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

        // ================================================================
        // STAGE 3 — LINT & UNIT TEST
        // Runs for BOTH PR builds and main merges.
        //
        // PR builds stop here — no images are built, no tags are created,
        // no version.txt is modified, no GitOps repository is touched.
        //
        // For Node services Vitest is detected automatically (no --ci flag).
        // For Python services pytest is used with --junitxml output.
        // ================================================================
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

                                        # Vitest does not accept --ci flag
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
                    // Parse JUnit XML results for the visual test report dashboard
                    junit allowEmptyResults: true, testResults: '**/test-results.xml,**/junit.xml'
                }
            }
        }

        // ================================================================
        // STAGE 3.5 — SECURITY SCAN (TRIVY)
        // Runs for both PR builds and main merges.
        // Scans the files of changed services for vulnerabilities.
        // ================================================================
        stage('Security Scan (Trivy)') {
            steps {
                script {
                    env.SERVICES_TO_BUILD.split(',').each { svc ->
                        def svcPath = ALL_SERVICES[svc.trim()]
                        container('security') {
                            echo "Running Trivy FS scan on ${svc}"
                            // Scan the filesystem for HIGH and CRITICAL vulnerabilities
                            // Returns non-zero exit code if vulnerabilities are found, failing the build
                            sh "trivy fs --severity HIGH,CRITICAL --exit-code 1 --no-progress ${svcPath}"
                        }
                    }
                }
            }
        }

        // ================================================================
        // STAGE 4 — GENERATE IMAGE TAG  [Main Only]
        // Generates the image tag using the short Git SHA.
        // ================================================================
        stage('Generate Image Tag') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    env.SHORT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    env.IMAGE_TAG = "${env.SHORT_SHA}"
                    echo "Planned image tag: ${env.IMAGE_TAG}"
                }
            }
        }

        // ================================================================
        // STAGE 5 — KANIKO BUILD & PUSH  [Main Only]
        // Builds and pushes Docker images for all changed services.
        //
        // If ANY build or push fails the stage fails immediately, and
        // the Declarative Pipeline will not proceed to later stages.
        // version.txt and Git tags are therefore never touched.
        // ================================================================
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

        // ================================================================
        // STAGE 6 — GITOPS CONFIG UPDATE  [Main Only]
        // Clones hpe-merch-config, patches the image newTag for every
        // changed service in downstream-clusters/base/kustomization.yaml,
        // commits and pushes the config repository.
        //
        // If this stage fails, version.txt and Git tags are NOT modified.
        // ================================================================
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
