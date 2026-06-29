// NITTE Alumni Shop — CI/CD Pipeline
//
// WHAT THIS PIPELINE DOES:
//   1. Checks out the source code repository (this repo).
//   2. Builds Docker images for each service using Kaniko (no Docker daemon required —
//      the cluster runtime is containerd, not Docker).
//   3. Pushes built images to the Nexus private registry.
//   4. Clones the SEPARATE GitOps configuration repository and bumps the image tags
//      in the dev overlay kustomization so ArgoCD auto-syncs the Dev cluster.
//
// WHY TWO REPOSITORIES?
//   GitOps principle: source code changes and Kubernetes manifests are decoupled.
//   The source repo (this file lives here) contains application code only.
//   The config repo contains all Kubernetes YAML, Kustomize overlays, and ArgoCD apps.
//   Jenkins only writes to the config repo in the GitOps stage — never to this repo.
//
// ONE-TIME PREREQUISITES (see docs/CICD_PIPELINE.md):
//   - Secret  jenkins/kaniko-docker-config  (Nexus credentials for Kaniko)
//   - Jenkins credential id 'github-token'   (username + PAT — must have write access to config repo)
//   - Environment variable CONFIG_REPO_URL set below must point to your GitOps config repository.

pipeline {
  agent {
    kubernetes {
      defaultContainer 'kaniko'
      yaml '''
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: nitte-ci
  annotations:
    # Disable Istio sidecar injection for CI pods — sidecars interfere with
    # Kaniko network egress and add unnecessary overhead.
    sidecar.istio.io/inject: "false"
spec:
  containers:
  - name: kaniko
    image: gcr.io/kaniko-project/executor:v1.20.0-debug
    command: ["/busybox/cat"]
    tty: true
    resources:
      requests: { memory: "256Mi", cpu: "200m" }
      limits:   { memory: "1536Mi", cpu: "1000m" }
    volumeMounts:
    - name: docker-config
      mountPath: /kaniko/.docker
  - name: tools
    image: alpine/git:latest
    command: ["cat"]
    tty: true
    resources:
      requests: { memory: "128Mi", cpu: "100m" }
      limits:   { memory: "256Mi", cpu: "500m" }
  volumes:
  - name: docker-config
    secret:
      # This secret must contain a valid config.json with Nexus auth.
      # Create with: kubectl create secret generic kaniko-docker-config \
      #   --from-file=config.json=path/to/nexus-config.json -n jenkins
      secretName: kaniko-docker-config
      items:
      - key: config.json
        path: config.json
'''
    }
  }

  parameters {
    string(
      name: 'SERVICES',
      defaultValue: 'all',
      description: 'Space-separated list of services to build, or "all". ' +
                   'Valid values: node-backend python-service frontend admin-dashboard merchant-portal notification-service'
    )
  }

  environment {
    // Nexus Docker registry address (NodePort service on the Admin cluster)
    REGISTRY = '192.168.56.202:8082'

    // Image tag: BUILD_NUMBER guarantees uniqueness and traceability back to this run.
    // We do NOT use 'latest' — mutable tags break GitOps determinism.
    TAG = "1.1.${BUILD_NUMBER}"

    // All services that have a Dockerfile under services/<name>/
    // loki-rbac-proxy is excluded until that service directory exists in the source repo.
    ALL_SVCS = 'node-backend python-service frontend admin-dashboard merchant-portal notification-service'

    // GitOps config repository — this is NOT the source code repo.
    // Jenkins clones this separately and only updates the image tags here.
    CONFIG_REPO_URL = 'https://github.com/YOUR_ORG/nitte-merch-config.git'

    // Path inside the config repo where the dev overlay kustomization lives.
    // Jenkins updates image tags here; ArgoCD detects the change and syncs nitte-dev.
    KUSTOMIZATION = 'overlays/dev/kustomization.yaml'
  }

  options {
    timeout(time: 40, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '15'))
  }

  stages {

    // ─────────────────────────────────────────────────────────────
    // Stage 1: Checkout source code
    // ─────────────────────────────────────────────────────────────
    stage('Checkout') {
      steps {
        container('tools') {
          checkout scm
          sh '''
            git config --global --add safe.directory "*"
            git rev-parse --short HEAD > .gitsha
            echo "Building tag $TAG from commit $(cat .gitsha)"
          '''
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Stage 2: Build & Push images with Kaniko
    //
    // WHY KANIKO?
    //   The Kubernetes nodes use containerd as the runtime (no Docker daemon).
    //   Kaniko builds OCI-compliant images from a Dockerfile without needing
    //   a Docker socket, making it safe to run inside Kubernetes pods.
    //
    // WHY --insecure / --skip-tls-verify?
    //   Nexus in this environment uses HTTP (no TLS certificate on the private
    //   registry). In a production environment you would add a valid TLS cert to
    //   Nexus and remove these flags.
    // ─────────────────────────────────────────────────────────────
    stage('Build & Push (Kaniko)') {
      steps {
        container('kaniko') {
          sh '''
            set -e

            SVCS="$SERVICES"
            [ "$SVCS" = "all" ] && SVCS="$ALL_SVCS"

            for s in $SVCS; do
              # All service Dockerfiles live under services/<service-name>/Dockerfile
              # This was previously wrong — the old pipeline used $s/Dockerfile which
              # would look in the repo root and fail for every service.
              CONTEXT_DIR="services/$s"

              if [ ! -f "$CONTEXT_DIR/Dockerfile" ]; then
                echo "!! $CONTEXT_DIR/Dockerfile not found — skipping $s"
                continue
              fi

              echo "======== Building $REGISTRY/nitte-merch/$s:$TAG ========"

              /kaniko/executor \
                --context="dir://$(pwd)/$CONTEXT_DIR" \
                --dockerfile="Dockerfile" \
                --destination="$REGISTRY/nitte-merch/$s:$TAG" \
                --insecure \
                --skip-tls-verify \
                --insecure-pull \
                --cache=false \
                --cleanup

              echo "✓ Pushed $REGISTRY/nitte-merch/$s:$TAG"
            done
          '''
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Stage 3: GitOps — bump image tags in the config repository
    //
    // WHY A SEPARATE CONFIG REPO?
    //   GitOps requires a clear audit trail of what is deployed and when.
    //   Kubernetes manifests in a dedicated repo means:
    //   - Every deployment is a git commit with an author and timestamp.
    //   - ArgoCD watches only the config repo — it never polls source code.
    //   - Rollback = revert the config repo commit. No re-running CI.
    //   - Promotion (dev → prod) = PR to update the prod overlay. Human reviewed.
    //
    // THIS STAGE:
    //   1. Clones the config repo.
    //   2. Updates overlays/dev/kustomization.yaml with the new image tags.
    //   3. Commits and pushes to main.
    //   ArgoCD detects the commit and syncs the Dev cluster automatically.
    //
    // PRODUCTION PROMOTION:
    //   To deploy to prod, open a PR that updates overlays/prod/kustomization.yaml.
    //   That PR is reviewed, approved, and merged by a human — Jenkins never
    //   automatically writes to the prod overlay.
    // ─────────────────────────────────────────────────────────────
    stage('GitOps: Bump dev image tags') {
      steps {
        container('tools') {
          withCredentials([usernamePassword(
            credentialsId: 'github-token',
            usernameVariable: 'GH_USER',
            passwordVariable: 'GH_TOKEN'
          )]) {
            sh '''
              set -e

              git config --global --add safe.directory "*"

              # Install yq — a portable YAML processor for patching kustomization files
              apk add --no-cache wget >/dev/null 2>&1 || true
              wget -qO /usr/local/bin/yq \
                https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64
              chmod +x /usr/local/bin/yq

              # Clone the GitOps config repository.
              # This is a DIFFERENT repository from the source code repo (this repo).
              # Jenkins writes ONLY to the config repo in this stage.
              REPO_URL="https://${GH_USER}:${GH_TOKEN}@$(echo $CONFIG_REPO_URL | sed 's|https://||')"
              git clone --depth=1 "$REPO_URL" config-repo
              cd config-repo

              # Verify the kustomization file exists before modifying it.
              # If it does not exist, the config repository is not set up correctly.
              if [ ! -f "$KUSTOMIZATION" ]; then
                echo "ERROR: $KUSTOMIZATION not found in config repo."
                echo "The GitOps config repository must be initialized before this pipeline runs."
                echo "See docs/GITOPS_SETUP.md for setup instructions."
                exit 1
              fi

              # Determine which services to update
              SVCS="$SERVICES"
              [ "$SVCS" = "all" ] && SVCS="$ALL_SVCS"

              # Bump image tag for each service in the dev overlay kustomization
              for s in $SVCS; do
                IMAGE_NAME="$REGISTRY/nitte-merch/$s"
                yq -i "(.images[] | select(.name == \\"$IMAGE_NAME\\") | .newTag) = \\"$TAG\\"" \
                  "$KUSTOMIZATION"
                echo "✓ set $IMAGE_NAME -> $TAG"
              done

              # Commit and push the tag bump
              git config user.email "ci@nitte.local"
              git config user.name  "jenkins-ci"
              git add "$KUSTOMIZATION"

              if git diff --cached --quiet; then
                echo "No tag changes to commit (images already at $TAG)."
              else
                git commit -m "ci: bump dev images to $TAG (Jenkins build #$BUILD_NUMBER)"
                git push "$REPO_URL" HEAD:main
                echo "✓ Pushed to config repo — ArgoCD will sync nitte-dev."
              fi
            '''
          }
        }
      }
    }
  }

  post {
    success {
      echo """
CI pipeline succeeded.
  Images pushed : $REGISTRY/nitte-merch/<service>:$TAG
  Config repo   : $CONFIG_REPO_URL
  ArgoCD will auto-sync the Dev cluster (nitte-dev namespace).

To promote to production:
  Open a PR in the config repo updating overlays/prod/kustomization.yaml
  with the same tag ($TAG), get it reviewed, and merge it.
"""
    }
    failure {
      echo "CI pipeline FAILED. Check the stage logs above for the root cause."
    }
    always {
      // Clean workspace to prevent stale build artifacts affecting the next run.
      cleanWs()
    }
  }
}
