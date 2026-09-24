import { App } from './App'
import { AuthProvider } from './store/auth'
import { ToastProvider } from './store/toast'

export function AppRoot() {
  return (
    <ToastProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ToastProvider>
  )
}
