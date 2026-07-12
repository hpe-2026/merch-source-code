// =============================================================================
// Jenkinsfile  —  merch-source-code (IMPROVED - Uses Shared Library)
// =============================================================================

library identifier: 'merch-shared-lib@main', retriever: modernSCM(
  [$class: 'GitSCMSource',
   remote: 'https://github.com/hpe-2026/jenkins-shared-library.git',
   credentialsId: 'github-pat']
)
// Service definitions
def SERVICES = [
    'frontend'             : 'services/frontend',
    'node-backend'         : 'services/node-backend',
    'python-service'       : 'services/python-service',
    'merchant-portal'      : 'services/merchant-portal',
    'notification-service' : 'services/notification-service',
    'admin-dashboard'      : 'services/admin-dashboard'
]

// Pipeline configuration
def config = [
    services         : SERVICES,
    nexusRegistry    : '192.168.56.10:30082',
    nexusRepo        : 'merch-docker',
    configRepoUrl    : 'https://github.com/hpe-2026/hpe-merch-config.git',
    healthEndpoints  : [
        'frontend'             : '/',
        'node-backend'         : '/api/health',
        'python-service'       : '/health',
        'merchant-portal'      : '/',
        'notification-service' : '/health',
        'admin-dashboard'      : '/'
    ],
    deployDomains   : [
        'dev'  : 'dev.nitte.edu',
        'prod' : 'nitte.edu'
    ]
]

// Execute the standard pipeline
merchPipeline(config)