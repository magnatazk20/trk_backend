import { useEffect, useMemo, useState } from 'react'
import AdminSidebar from '../components/AdminSidebar'
import './Admin.css'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

export default function AdminSiteSettings() {
  const token = useMemo(
    () => localStorage.getItem('token') ?? sessionStorage.getItem('token') ?? '',
    []
  )

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [siteTitle, setSiteTitle] = useState('')
  const [siteDescription, setSiteDescription] = useState('')
  const [siteLogoUrl, setSiteLogoUrl] = useState('')

  useEffect(() => {
    const loadSettings = async () => {
      setLoading(true)
      setError('')
      setSuccess('')

      try {
        const res = await fetch(`${API_URL}/api/admin/site-settings`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })

        const data = (await res.json()) as {
          ok?: boolean
          error?: string
          settings?: {
            siteTitle?: string
            siteDescription?: string
            siteLogoUrl?: string
          }
        }

        if (!res.ok || !data?.ok) {
          setError(data?.error ?? 'Falha ao carregar configurações do site.')
          return
        }

        setSiteTitle(String(data.settings?.siteTitle ?? ''))
        setSiteDescription(String(data.settings?.siteDescription ?? ''))
        setSiteLogoUrl(String(data.settings?.siteLogoUrl ?? ''))
      } catch {
        setError('Erro de conexão ao carregar configurações.')
      } finally {
        setLoading(false)
      }
    }

    loadSettings()
  }, [token])

  const saveSettings = async () => {
    setSaving(true)
    setError('')
    setSuccess('')

    try {
      const res = await fetch(`${API_URL}/api/admin/site-settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          siteTitle: siteTitle.trim(),
          siteDescription: siteDescription.trim(),
          siteLogoUrl: siteLogoUrl.trim(),
        }),
      })

      const data = (await res.json()) as {
        ok?: boolean
        error?: string
        message?: string
      }

      if (!res.ok || !data?.ok) {
        setError(data?.error ?? 'Falha ao salvar configurações do site.')
        return
      }

      setSuccess(data?.message ?? 'Configurações salvas com sucesso.')
    } catch {
      setError('Erro de conexão ao salvar configurações.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="admin-page">
      <AdminSidebar />
      <section className="admin-content">
        <header className="admin-header">
          <div>
            <h1>Editar Site</h1>
            <p className="admin-subtitle">
              Altere o título, descrição e logo do site e salve no banco de dados.
            </p>
          </div>
        </header>

        <section className="admin-panel admin-panel-wide">
          <div className="admin-panel-head">
            <h2>Configurações do Site</h2>
            <span>Painel de conteúdo</span>
          </div>

          {loading ? <p>Carregando configurações...</p> : null}
          {error ? <p className="admin-kpi-error">{error}</p> : null}
          {success ? <p className="admin-chip soft">{success}</p> : null}

          <div className="admin-form-grid" style={{ marginTop: 16 }}>
            <label className="admin-form-group">
              <span>Título do site</span>
              <input
                type="text"
                value={siteTitle}
                onChange={(e) => setSiteTitle(e.target.value)}
                placeholder="Digite o título do site"
                maxLength={150}
              />
            </label>

            <label className="admin-form-group">
              <span>Descrição do site</span>
              <textarea
                value={siteDescription}
                onChange={(e) => setSiteDescription(e.target.value)}
                placeholder="Digite a descrição do site"
                rows={5}
                maxLength={1000}
              />
            </label>

            <label className="admin-form-group">
              <span>Foto/logo do site (URL)</span>
              <input
                type="url"
                value={siteLogoUrl}
                onChange={(e) => setSiteLogoUrl(e.target.value)}
                placeholder="https://seusite.com/logo.png"
                maxLength={500}
              />
            </label>
          </div>

          <div style={{ marginTop: 16 }}>
            <button className="admin-primary-btn" type="button" onClick={saveSettings} disabled={saving || loading}>
              {saving ? 'Salvando...' : 'Salvar alterações'}
            </button>
          </div>
        </section>
      </section>
    </main>
  )
}
