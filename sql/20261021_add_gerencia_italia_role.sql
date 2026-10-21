BEGIN;

INSERT INTO roles (
  name,
  description
)
VALUES (
  'GERENCIA_ITALIA',
  'Gerencia de distribución Chile. Acceso de solo lectura con valorización en USD.'
)
ON CONFLICT (name)
DO UPDATE SET
  description = EXCLUDED.description;

COMMIT;

-- Verificación:
-- SELECT id, name, description
-- FROM roles
-- WHERE name = 'GERENCIA_ITALIA';

-- Para asignar el rol a un usuario EXISTENTE, reemplazar el correo:
--
-- UPDATE users
-- SET role_id = (
--   SELECT id
--   FROM roles
--   WHERE name = 'GERENCIA_ITALIA'
-- )
-- WHERE LOWER(email) = LOWER('gerencia@ejemplo.com');
