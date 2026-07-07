// API Configuration - automatically detects environment

function getAPIBase() {
  // If API URL is set via environment variable, use it
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL
  }

  // If running in browser
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol
    const hostname = window.location.hostname
    const port = window.location.port

    // If accessing via localhost (development)
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:3000'
    }

    // In k8s — API lives at api.<same-base-domain>
    const parts = hostname.split('.')
    parts[0] = 'api'
    return `${protocol}//${parts.join('.')}${port ? ':' + port : ''}`
  }

  // Fallback for SSR or server-side
  return 'http://node-backend:3000'
}

export const API_BASE = getAPIBase()

// Helper to get auth headers
export const auth = () => ({
  headers: {
    Authorization: `Bearer ${localStorage.getItem('token')}`,
  },
})

// Helper to get auth headers with content type for uploads
export const authUpload = () => ({
  headers: {
    Authorization: `Bearer ${localStorage.getItem('token')}`,
    'Content-Type': 'multipart/form-data',
  },
})

export default API_BASE
