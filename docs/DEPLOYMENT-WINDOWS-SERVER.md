# Despliegue en Windows Server

Guía para clonar y poner en marcha `mbc-backup-service` en el servidor de producción **sin interrumpir** los procesos PM2 existentes (`5s-api`, `almacen-backend`, `defectos-calidad`, `kpi-backend`, `kpi-sync-agent`, `mantenimiento-api`, `minutas-api`, `tareas-api`).

> [!CAUTION]
> **Prohibido** durante este despliegue: `pm2 restart all`, `pm2 delete all`, `pm2 kill`, detener/reiniciar procesos existentes, `pm2 update`, cambiar configuraciones globales de PM2 o reiniciar MySQL. Todo comando PM2 de esta guía nombra explícitamente `mbc-backup-service`.

## 0. Requisitos previos

- Node.js 22.18+ (rama 22) o 26 LTS ya instalado (no se instala ni actualiza nada global).
- Git, PM2 (ya instalado), `sqlite3.exe` en `C:\Servidor\Herramientas\SQLite\`.
- `mysqldump.exe` **8.4** (incluido con MySQL Server 8.4, carpeta `bin`).
- Espacio libre en el volumen de respaldos ≥ reserva (`MIN_FREE_GB`) + tamaño estimado.

## 1. Fotografía del estado actual de PM2 (solo lectura)

```powershell
pm2 jlist | ConvertFrom-Json | Select-Object name, @{n='status';e={$_.pm2_env.status}}, pm_id | Format-Table
```

Guarde la salida: al final todos deben seguir `online` con el mismo `pm_id`.

## 2. Clonar e instalar

```powershell
cd C:\Servidor
git clone <url-del-repositorio> mbc-backup-service
cd mbc-backup-service
npm ci                        # incluye TypeScript (devDependencies) para compilar
npm run build
npm test                      # opcional, no toca bases reales
```

## 3. Cuenta MySQL dedicada

1. Edite una **copia local** de `config\create-mbc-backup-user.sql` y reemplace `CAMBIAR_POR_CONTRASENA_FUERTE` (no guarde la contraseña en Git).
2. Ejecútelo manualmente con una cuenta administrativa:
   ```powershell
   mysql -u root -p < config\create-mbc-backup-user.sql
   ```
3. Compruebe: `SHOW GRANTS FOR 'mbc_backup'@'127.0.0.1';`

## 4. Configuración

```powershell
copy .env.example .env
copy config\databases.example.json config\databases.json
notepad .env
notepad config\databases.json
```

En `.env` (producción):

```ini
BACKUP_ROOT=C:\Servidor\BasesDatos\Respaldos\Diarios
SQLITE3_PATH=C:\Servidor\Herramientas\SQLite\sqlite3.exe
MYSQLDUMP_PATH=C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe
MIN_FREE_GB=10
MYSQL_PRINCIPAL_PASSWORD=<contraseña de mbc_backup>
```

`MBC_MODE` y `ENABLE_SCHEDULER` los fija `ecosystem.config.cjs` (`production`/`true`); para los comandos manuales en el servidor añada `MBC_MODE=production` al `.env` (o, para pruebas puntuales, `MBC_ALLOW_LIVE=true`).

Proteja los archivos (ver README → Seguridad): `icacls` sobre `.env`, `runtime` y `Respaldos`; BitLocker en el volumen.

## 5. Validaciones previas (no escriben respaldos)

```powershell
npm run validate-config
npm run tools            # mysqldump 8.4 y sqlite3 disponibles
npm run backup:dry-run   # se conecta a MySQL SOLO para listar esquemas; muestra qué se respaldaría
```

Verifique que aparezcan `gestor_calidad_prod`, `diseno`, `mantenimiento`, `calidad_mbc`, `avance_material`, `encuestas_5s` y la base SQLite `kpis`.

## 6. Primera copia manual (opcional pero recomendada)

Fuera de las horas pico (usa prioridad baja, secuencial):

```powershell
npm run backup:run -- --confirm
npm run backup:verify -- --latest
```

## 7. Agregar el proceso a PM2 (solo `mbc-backup-service`)

```powershell
cd C:\Servidor\mbc-backup-service
pm2 start ecosystem.config.cjs
pm2 save                      # persiste la lista; no modifica configuraciones globales
```

Si PM2 ya se reinicia con el servidor (servicio/`pm2-windows-startup`/tarea programada existente), `pm2 save` es suficiente. **No** reconfigure el arranque de PM2 si ya funciona.

## 8. Comprobar que los demás procesos siguen ONLINE

```powershell
pm2 list
pm2 jlist | ConvertFrom-Json | Select-Object name, @{n='status';e={$_.pm2_env.status}}, pm_id, @{n='restarts';e={$_.pm2_env.restart_time}} | Format-Table
```

Compare con el paso 1: las 8 aplicaciones previas deben estar `online`, con el mismo `pm_id` y **sin aumento** de reinicios. Después:

```powershell
pm2 logs mbc-backup-service --lines 50 --nostream
npm run health-check
Get-Content runtime\logs\mbc-backup-service.log -Tail 20
```

El log debe mostrar `mbc-backup-service iniciado`, `Programador iniciado` con la próxima ejecución a las 23:59 y la evaluación de recuperación.

## 9. Operación diaria

| Tarea | Comando (siempre nombrando el proceso) |
|---|---|
| Estado | `pm2 describe mbc-backup-service` · `npm run health-check` |
| Logs | `pm2 logs mbc-backup-service` · `runtime\logs\mbc-backup-service.log` |
| Reinicio ordenado | `pm2 restart mbc-backup-service --update-env` |
| Detener | `pm2 stop mbc-backup-service` |
| Quitar | `pm2 delete mbc-backup-service` (solo ese nombre) |
| Actualizar versión | `git pull; npm ci; npm run build; pm2 restart mbc-backup-service --update-env` |

`pm2 stop/restart` envía el apagado ordenado: si hay una copia activa se le da hasta `SHUTDOWN_GRACE_SECONDS` (90 s) para terminar la base en curso; `kill_timeout` de PM2 es 150 s.

Los registros de ejecución están en `runtime\state\runs\` y el estado en `runtime\state\state.json`.

## 10. Reversión

`pm2 delete mbc-backup-service` y `pm2 save`. No afecta a ningún otro proceso ni a los respaldos ya generados.

## 11. Lista de verificación final

- [ ] `pm2 list`: las 8 apps previas `online`, sin reinicios nuevos; `mbc-backup-service` `online`.
- [ ] `npm run backup:dry-run` detecta todos los esquemas esperados.
- [ ] Primera copia manual validada con `backup:verify`.
- [ ] `.env`, `runtime\` y `Respaldos\` con permisos NTFS restringidos; BitLocker habilitado.
- [ ] Contraseña de `mbc_backup` solo en `.env`.
- [ ] Plan de copia externa de `C:\Servidor\BasesDatos\Respaldos`.
