import { Archive } from './Archive'
import { AccountProvider } from './auth'
import './archive.css'

export function ArchivePage() {
  return (
    <AccountProvider>
      <Archive />
    </AccountProvider>
  )
}
