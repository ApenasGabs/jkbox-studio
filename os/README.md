# Execução Nativa & Auto-Updater (`jkbox-update`)

Artefatos da **Etapa 2 da Fase 2** para rodar o `jkbox-studio` nativamente em Linux (`systemd`) sem Docker, consumindo os pacotes pré-compilados das GitHub Releases.

## Estrutura de Instalação (`/opt/jkbox`)

```text
/opt/jkbox/
├── releases/
│   ├── v0.1.0/
│   └── v0.2.0/
└── current -> /opt/jkbox/releases/v0.2.0
```

Dados persistentes ficam em `/var/lib/jkbox` (`StateDirectory=jkbox`) e variáveis opcionais em `/etc/jkbox/jkbox.env`.

## Units `systemd`

- `os/systemd/jkbox.service` — executa `node /opt/jkbox/current/server/dist/index.js` como usuário `jkbox`.
- `os/systemd/jkbox-update.service` — executa `/opt/jkbox/current/os/jkbox-update.sh` (`oneshot`).
- `os/systemd/jkbox-update.timer` — agenda checagens periódicas (5 min após boot e a cada 6h).

## Uso do `os/jkbox-update.sh`

```bash
# Simulação sem alterar arquivos ou reiniciar serviços
./os/jkbox-update.sh --dry-run

# Atualização real (com validação SHA256SUMS, symlink atômico e rollback se /api/health falhar)
sudo /opt/jkbox/current/os/jkbox-update.sh
```
