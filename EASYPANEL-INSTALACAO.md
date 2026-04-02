# Instalação do sistema no EasyPanel (Frontend + Backend)

Este guia mostra como subir seu projeto no **EasyPanel** e quais portas usar.

---

## Portas corretas deste projeto

Com base no código atual:

- **Backend (Express):** `3333`  
  > Definido em `noor661/src/server.ts`:
  > `const PORT = process.env.PORT ?? 3333`

- **Frontend (Vite):**
  - Em produção no EasyPanel, use o preview/build na porta **4173**
  - Em desenvolvimento local, o Vite usa normalmente **5173**

✅ Para EasyPanel, use:

- **Frontend:** `4173`
- **Backend:** `3333`

---

## Estrutura do projeto

- Backend Node/Express: `noor661/`
- Frontend Vite/React: `noor661/frontend/`

---

## 1) Backend no EasyPanel (o que preencher)

Crie um serviço para o backend apontando para a pasta `noor661`.

- **Root Directory:** `noor661`
- **Install/Build Command:**
```bash
npm install
```
- **Start Command:** (ajuste ao seu package.json)
```bash
npm run build && npm start
```
- **Internal/Container Port:** `3333`

### ENV do backend

Use assim:

```env
PORT=3333
DB_HOST=pglm-backend_magnata001
DB_PORT=3306
DB_USER=magnata001
DB_PASSWORD=gregory645
DB_NAME=magnata001
JWT_SECRET=troque_este_segredo
JWT_EXPIRES_IN=7d
APP_BASE_URL=https://pgl-m.com
```

---

## 2) Frontend no EasyPanel (o que preencher)

Crie um serviço para o frontend apontando para `noor661/frontend`.

### Preenchimento EXATO (como está na tela do EasyPanel)

- **Versão (Node):** `1.41.0` (pode manter como está)
- **Comando de Instalação:**
```bash
npm install
```
- **Comando de Build:**
```bash
npm run build
```
- **Comando de início:**
```bash
npm run preview -- --host 0.0.0.0 --port 4173
```
- **Porta interna do app:** `4173`
- **Root Directory:** `noor661/frontend`

### Muito importante

No seu print/texto, o campo estava assim (invertido):
- Instalação = `npm run preview...`
- Build = `npm install && npm run build`
- Início = vazio

Isso está **errado**.  
O correto é exatamente:

1. Instalação = `npm install`  
2. Build = `npm run build`  
3. Início = `npm run preview -- --host 0.0.0.0 --port 4173`

### ENV do frontend (obrigatório)

No frontend, coloque exatamente:

```env
VITE_API_URL=https://api.pgl-m.com
```

❌ Errado:
```env
VITE_API_URL=VITE_API_URL=https://api.pgl-m.com
```

✅ Certo:
```env
VITE_API_URL=https://api.pgl-m.com
```

---

## 3) Seu erro atual explicado (confirmado pelos logs)

Você informou que ao abrir `https://pgl-m.com` recebe:

```html
<script type="module" src="/src/main.tsx"></script>
```

E no log do frontend aparece requisição para:

- `GET /`
- `GET /src/main.tsx`

Isso confirma que o servidor está entregando o projeto como arquivo fonte (dev), e não o build de produção.

### Causa mais provável no seu caso
Seu frontend está com `Caddyfile` no projeto (`noor661/frontend/Caddyfile`) e o container está servindo arquivos estáticos diretamente (index.html da raiz), ignorando o fluxo de `vite build + vite preview`.

### Correção definitiva (escolha 1 opção)

#### Opção A (recomendada): remover Caddyfile do frontend para usar Vite preview
1. Renomeie o arquivo:
   - de: `noor661/frontend/Caddyfile`
   - para: `noor661/frontend/Caddyfile.bak`
2. No EasyPanel frontend, mantenha:
   - Instalação: `npm install`
   - Build: `npm run build`
   - Início: `npm run preview -- --host 0.0.0.0 --port 4173`
   - Porta: `4173`
3. Redeploy.
4. Faça purge de cache no Cloudflare.
5. Teste novamente.

#### Opção B: manter Caddy, mas servir somente `/dist`
Se você quiser usar Caddy, então ele deve servir apenas o conteúdo de `dist` após o build (não pode servir a raiz com `/src/main.tsx`).

### Como validar que corrigiu
Abra `https://pgl-m.com` e veja o HTML:
- ❌ não pode conter `/src/main.tsx`
- ✅ deve conter script em `/assets/...` (arquivo buildado)

---

## 4) Ajuste importante no backend (webhook)

No `noor661/src/server.ts` existe:

```ts
callbackUrl: 'https://localhost:3333/api/CASHIN/webhook',
```

Troque para domínio público em produção, ex.:

```ts
callbackUrl: 'https://api.pgl-m.com/api/CASHIN/webhook',
```

Sem isso, webhook de pagamento pode falhar.

---

## 5) Checklist final

- [ ] Backend em `3333`
- [ ] Frontend em `4173`
- [ ] Root frontend = `noor661/frontend`
- [ ] `VITE_API_URL=https://api.pgl-m.com` (sem duplicação)
- [ ] Frontend buildado com `npm run build`
- [ ] Frontend iniciado com `vite preview --port 4173`
- [ ] Após deploy, HTML **sem** `/src/main.tsx`
- [ ] Webhook sem `localhost` no backend

---

## Resumo rápido

**Portas no EasyPanel:**
- Frontend: **4173**
- Backend: **3333**

**No frontend ENV:**
- `VITE_API_URL=https://api.pgl-m.com`
