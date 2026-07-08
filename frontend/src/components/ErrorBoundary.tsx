import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: '#ccc', fontFamily: 'monospace' }}>
          <h2 style={{ color: '#f87171' }}>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>{this.state.error.message}</pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: '8px 16px', cursor: 'pointer', background: '#333', color: '#fff', border: '1px solid #555', borderRadius: 4 }}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
