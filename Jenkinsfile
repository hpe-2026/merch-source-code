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
                    env.COMMIT_AUTHOR_EMAIL = sh(script: "git log -1 --pretty=format:'%ae'", returnStdout: true).trim()

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

                    sh "git fetch origin ${env.IS_PR == 'true' ? env.CHANGE_TARGET : 'main'} --depth=200 || true"

                    def mergeBase = sh(script: "git merge-base ${targetRef} HEAD || echo HEAD", returnStdout: true).trim()
                    def diffOut   = sh(script: "git diff --name-only ${mergeBase}...HEAD || true", returnStdout: true).trim()

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
        // STAGE 4 — GENERATE VERSION  [Main Only]
        // Reads the current version from version.txt, calculates the next
        // patch version, and stores everything in env vars.
        //
        // IMPORTANT: version.txt is NOT written here.
        //            It is written only in Stage 7, after images and GitOps
        //            have both succeeded.
        // ================================================================
        stage('Generate Version') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                script {
                    // Read current version and bump patch
                    if (!fileExists('version.txt')) {
                        env.NEW_VERSION = '1.0.0'
                    } else {
                        def currentVersion = readFile('version.txt').trim()
                        def parts = currentVersion.split('\\.')
                        def major = parts[0]
                        def minor = parts[1]
                        def patch = parts[2].toInteger() + 1
                        env.NEW_VERSION = "${major}.${minor}.${patch}"
                    }

                    env.SHORT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    env.IMAGE_TAG  = "${env.NEW_VERSION}-${env.SHORT_SHA}"
                    env.GIT_TAG    = "v${env.NEW_VERSION}"

                    echo "Planned release: ${env.GIT_TAG}  (image tag: ${env.IMAGE_TAG})"

                    // Abort early if the tag already exists in the remote
                    def tagExists = sh(
                        script: "git ls-remote --tags origin ${env.GIT_TAG} | grep -c ${env.GIT_TAG} || true",
                        returnStdout: true
                    ).trim()
                    if (tagExists != '0' && tagExists != '') {
                        error("Git tag ${env.GIT_TAG} already exists on origin. Aborting to prevent overwrite.")
                    }
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
                        git commit -m "chore: deploy release ${env.GIT_TAG}" || true
                        git push origin main
                    """
                }
            }
        }

        // ================================================================
        // STAGE 7 — COMMIT VERSION.TXT  [Main Only]
        // Only reached after Kaniko AND GitOps both succeeded.
        //
        // Writes NEW_VERSION into version.txt, commits it, and pushes to
        // the source repository main branch.
        //
        // The [skip ci] marker prevents Jenkins from triggering another
        // build for this automation commit.
        // ================================================================
        stage('Commit version.txt') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID, usernameVariable: 'GIT_USER', passwordVariable: 'GIT_PASS')]) {
                    script {
                        writeFile file: 'version.txt', text: env.NEW_VERSION
                        sh """
                            git config --global user.email "jenkins@nitte.edu"
                            git config --global user.name  "Jenkins Automation"

                            REPO_URL=\$(git config remote.origin.url | sed -e 's/.*github.com[:\\/]//' -e 's/\\.git\$//')
                            git remote set-url origin "https://${GIT_USER}:${GIT_PASS}@github.com/\${REPO_URL}.git"

                            git add version.txt
                            git commit -m "chore: bump version to ${env.GIT_TAG} [skip ci]"
                            git push origin HEAD:main
                        """
                    }
                }
            }
        }

        // ================================================================
        // STAGE 8 — PUSH GIT TAG  [Main Only]
        // Only reached after version.txt is successfully committed.
        //
        // Creates and pushes the annotated release tag (vX.Y.Z).
        // This is the FINAL step of a successful release.
        // ================================================================
        stage('Push Git Tag') {
            when { expression { env.IS_MAIN == 'true' } }
            steps {
                withCredentials([usernamePassword(credentialsId: env.GITHUB_CRED_ID, usernameVariable: 'GIT_USER', passwordVariable: 'GIT_PASS')]) {
                    sh """
                        git config --global user.email "jenkins@nitte.edu"
                        git config --global user.name  "Jenkins Automation"

                        REPO_URL=\$(git config remote.origin.url | sed -e 's/.*github.com[:\\/]//' -e 's/\\.git\$//')
                        git remote set-url origin "https://${GIT_USER}:${GIT_PASS}@github.com/\${REPO_URL}.git"

                        git tag ${env.GIT_TAG}
                        git push origin ${env.GIT_TAG}
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
                    emailext subject: "SUCCESS: Deployment ${env.GIT_TAG} #${env.BUILD_NUMBER}",
                             body: "Release ${env.GIT_TAG} — services (${env.SERVICES_TO_BUILD}) built and deployed.\n\nImage tag: ${env.IMAGE_TAG}\n\n${env.BUILD_URL}",
                             to: "${env.OWNER_EMAIL},${env.COMMIT_AUTHOR_EMAIL}"
                }
            }
        }
        failure {
            script {
                if (env.IS_PR == 'true') {
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
