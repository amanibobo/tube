import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { SESSION_EXPIRED, setTokenSource } from './api'

export interface Viewer { sub: string; name: string; picture: string | null }

/** `off`: this build has no sign-in (no Auth0 domain, no dev auth), so the account UI is hidden. */
export type Session =
  | { status: 'off' }
  | { status: 'checking' }
  | { status: 'signed-out'; notice: string | null }
  | { status: 'signed-in'; viewer: Viewer }

export interface Account { session: Session; signIn: () => void; signOut: () => void }

const OFF: Account = { session: { status: 'off' }, signIn: () => {}, signOut: () => {} }
const AccountContext = createContext<Account>(OFF)
export const useAccount = () => useContext(AccountContext)

/** The archive lives at /archive inside Tube, so sign-in and sign-out come back there, not to the landing page at /. */
const HOME = `${window.location.origin}/archive`

const AUTH0 = {
  domain: String(import.meta.env.VITE_AUTH0_DOMAIN ?? ''),
  clientId: String(import.meta.env.VITE_AUTH0_CLIENT_ID ?? ''),
  audience: String(import.meta.env.VITE_AUTH0_AUDIENCE || 'https://vidsearch-api'),
}

export function AccountProvider({ children }: { children: ReactNode }) {
  if (AUTH0.domain) {
    return (
      <Auth0Provider
        domain={AUTH0.domain}
        clientId={AUTH0.clientId}
        authorizationParams={{ audience: AUTH0.audience, redirect_uri: HOME }}
        // Refresh tokens in local storage keep the session across reloads where third-party cookies are blocked.
        cacheLocation="localstorage"
        useRefreshTokens
        useRefreshTokensFallback
      >
        <Auth0Account>{children}</Auth0Account>
      </Auth0Provider>
    )
  }
  // import.meta.env.DEV is false in production builds, so this branch and DevAccount are dropped from the bundle.
  if (import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH) return <DevAccount user={String(import.meta.env.VITE_DEV_AUTH)}>{children}</DevAccount>
  return <AccountContext.Provider value={OFF}>{children}</AccountContext.Provider>
}

function Auth0Account({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0()
  const [notice, setNotice] = useState<string | null>(null)
  const sub = isAuthenticated ? user?.sub ?? null : null

  // Layout effect: the token source must be in place before any child's first fetch (passive effects run later).
  useLayoutEffect(() => {
    if (!sub) { setTokenSource(null); return }
    setTokenSource({
      token: async (fresh) => {
        const token = await getAccessTokenSilently({ authorizationParams: { audience: AUTH0.audience }, cacheMode: fresh ? 'off' : 'on' })
        if (!token) throw new Error('Auth0 returned no access token')
        return token
      },
      expired: () => {
        setTokenSource(null)
        setNotice(SESSION_EXPIRED)
        void logout({ openUrl: false })
      },
    })
    return () => setTokenSource(null)
  }, [sub, getAccessTokenSilently, logout])

  const account = useMemo<Account>(() => ({
    session: isLoading ? { status: 'checking' }
      : sub && user ? { status: 'signed-in', viewer: { sub, name: user.name || user.nickname || user.email || sub, picture: user.picture ?? null } }
      : { status: 'signed-out', notice },
    signIn: () => void loginWithRedirect(),
    signOut: () => void logout({ logoutParams: { returnTo: HOME } }),
  }), [isLoading, sub, user, notice, loginWithRedirect, logout])
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>
}

const DEV_USER_KEY = 'vidsearch.dev-user'

/**
 * Dev builds with VITE_DEV_AUTH=<sub> and an API run with VS_DEV_AUTH=1: signed in as <sub>, sending `Bearer dev:<sub>`.
 * localStorage `vidsearch.dev-user` overrides the user for one browser profile ('' = signed out).
 */
function DevAccount({ user, children }: { user: string; children: ReactNode }) {
  const [sub, setSub] = useState<string | null>(() => {
    try { const v = localStorage.getItem(DEV_USER_KEY); return v === null ? user : v || null } catch { return user }
  })
  const [notice, setNotice] = useState<string | null>(null)
  const remember = (v: string | null) => { try { localStorage.setItem(DEV_USER_KEY, v ?? '') } catch { /* private mode */ } setSub(v) }

  useLayoutEffect(() => {
    if (!sub) { setTokenSource(null); return }
    setTokenSource({
      token: async () => `dev:${sub}`,
      expired: () => { setTokenSource(null); setNotice(SESSION_EXPIRED); setSub(null) },
    })
    return () => setTokenSource(null)
  }, [sub])

  const account = useMemo<Account>(() => ({
    session: sub ? { status: 'signed-in', viewer: { sub, name: sub, picture: null } } : { status: 'signed-out', notice },
    signIn: () => { setNotice(null); remember(user) },
    signOut: () => remember(null),
  }), [sub, notice, user])
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>
}
