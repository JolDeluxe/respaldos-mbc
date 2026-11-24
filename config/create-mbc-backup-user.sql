-- =============================================================================
-- mbc-backup-service: cuenta MySQL dedicada "mbc_backup" (MySQL 8.0 / 8.4)
--
-- NO se ejecuta automáticamente. Revíselo y ejecútelo manualmente, con una cuenta
-- administrativa, en la instancia a respaldar:
--     mysql -u root -p < config\create-mbc-backup-user.sql
--
-- ANTES de ejecutarlo reemplace  CAMBIAR_POR_CONTRASENA_FUERTE  por una contraseña
-- larga y aleatoria. Esa misma contraseña va SOLO en el .env del servidor
-- (variable MYSQL_PRINCIPAL_PASSWORD). No la guarde en Git ni en este archivo versionado.
--
-- La cuenta solo permite conexiones locales ('127.0.0.1'/'localhost'). Si la instancia
-- está en otro host, cree la cuenta con el host de origen correspondiente.
-- =============================================================================

CREATE USER IF NOT EXISTS 'mbc_backup'@'127.0.0.1'
  IDENTIFIED BY 'CAMBIAR_POR_CONTRASENA_FUERTE'
  WITH MAX_USER_CONNECTIONS 3;

CREATE USER IF NOT EXISTS 'mbc_backup'@'localhost'
  IDENTIFIED BY 'CAMBIAR_POR_CONTRASENA_FUERTE'
  WITH MAX_USER_CONNECTIONS 3;

-- Privilegios mínimos para descubrir esquemas y exportar con:
--   --single-transaction --routines --events --triggers --no-tablespaces
--
--   SELECT        leer datos y metadatos (information_schema) de todos los esquemas
--   SHOW VIEW     exportar vistas
--   TRIGGER       exportar triggers
--   EVENT         exportar eventos programados (--events)
--   SHOW_ROUTINE  exportar procedimientos/funciones (--routines); privilegio dinámico (8.0.20+ / 8.4)
--
-- NO se otorgan: INSERT/UPDATE/DELETE/DROP/ALTER, SUPER, PROCESS (innecesario con
-- --no-tablespaces), ni GRANT OPTION. La cuenta es de solo lectura.
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, SHOW_ROUTINE ON *.* TO 'mbc_backup'@'127.0.0.1';
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, SHOW_ROUTINE ON *.* TO 'mbc_backup'@'localhost';

-- OPCIONAL (solo si el servidor usa gtid_mode=ON y se quitara --set-gtid-purged=OFF):
-- GRANT RELOAD ON *.* ...  (o el privilegio dinámico FLUSH_TABLES).
-- Con --set-gtid-purged=OFF (valor usado por el servicio) NO es necesario.

-- LOCK TABLES tampoco se otorga: con --single-transaction no se bloquean tablas InnoDB.
-- Las tablas MyISAM u otros motores no transaccionales no tendrían instantánea consistente;
-- el servicio registra una advertencia cuando detecta tablas no InnoDB.

FLUSH PRIVILEGES;

-- Verificación:
-- SHOW GRANTS FOR 'mbc_backup'@'127.0.0.1';
