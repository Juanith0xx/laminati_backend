# Laminatiword Backend — contrato MVP para frontend

Fecha de cierre: 2026-09-01

## 1. Alcance congelado para frontend

El frontend puede construirse contra estos módulos sin depender de la emisión DTE real en Relbase:

- Autenticación de cliente y administrador.
- Catálogo público, filtros y detalle de producto.
- Galería de imágenes en detalle de producto.
- Creación de orden WEB autenticada.
- BOLETA y FACTURA con empresa asociada al usuario.
- Reserva temporal de stock para órdenes WEB.
- Listado y detalle de órdenes del cliente.
- Cancelación de orden no pagada.
- Transferencia bancaria manual.
- Carga de comprobante.
- Aprobación/rechazo administrativo.
- Confirmación de reserva al aprobar pago.
- Preparación automática del DTE local después de PAID.
- Retiro en tienda y QR.
- POS administrativo.
- Catálogo/backoffice administrativo.
- Sincronización Relbase de productos, inventario y clientes.

La emisión DTE POST real hacia Relbase V2 continúa deshabilitada intencionalmente hasta cerrar el contrato de escritura.

## 2. Migración obligatoria antes de usar /api/orders

Ejecutar:

```sql
\i sql/20260901_backend_close_web_orders.sql
```

O copiar el contenido del archivo y ejecutarlo en `laminatiword_dev`.

## 3. Variables nuevas

```env
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
WEB_ORDER_RESERVATION_MINUTES=2880
```

Para producción, `CORS_ORIGINS` debe contener únicamente los dominios reales del frontend.

## 4. Endpoints frontend público / cliente

### Salud

`GET /api/health`

### Autenticación

`POST /api/auth/register`

`POST /api/auth/login`

`GET /api/auth/me` — Bearer JWT

`/me` incluye las empresas activas asociadas al usuario. Para FACTURA, el frontend debe enviar uno de esos `company_id`.

### Catálogo

`GET /api/products`

Filtros soportados:

- `category`
- `brand`
- `collection`
- `finish`
- `search`
- `featured=true|false`
- `in_stock=true|false`
- `sort=featured|name_asc|name_desc|price_asc|price_desc|newest`
- `page`
- `limit`

`GET /api/products/:slug`

El detalle incluye `product.images`.

`GET /api/catalog/filters`

### Órdenes WEB

Todas requieren `Authorization: Bearer <token>`.

#### Crear orden

`POST /api/orders`

BOLETA:

```json
{
  "idempotency_key": "UUID-GENERADO-POR-EL-FRONTEND",
  "document_type": "BOLETA",
  "items": [
    {
      "product_id": "UUID-PRODUCTO",
      "quantity": 1
    }
  ],
  "notes": "Opcional"
}
```

FACTURA:

```json
{
  "idempotency_key": "UUID-GENERADO-POR-EL-FRONTEND",
  "document_type": "FACTURA",
  "company_id": "UUID-EMPRESA-ASOCIADA-AL-USUARIO",
  "items": [
    {
      "product_id": "UUID-PRODUCTO",
      "quantity": 1
    }
  ]
}
```

Reglas importantes:

- El frontend nunca envía precio.
- El backend vuelve a leer precio/promoción desde PostgreSQL.
- El backend valida stock en la bodega configurada en `RELBASE_DEFAULT_WAREHOUSE_ID`.
- El backend crea una reserva `ACTIVE` con expiración.
- Para FACTURA se usan los datos de `customer_companies`; no se confía en datos tributarios arbitrarios enviados por el navegador.
- `idempotency_key` evita crear dos órdenes por doble click/retry.

#### Mis órdenes

`GET /api/orders?page=1&limit=20`

Filtros opcionales:

- `status`
- `payment_status`
- `source`

Un CLIENTE sólo ve sus órdenes. ADMIN puede ver todas.

#### Detalle

`GET /api/orders/:orderId`

Incluye:

- order
- billing
- items
- payment
- reservations
- tax_document

#### Cancelar no pagada

`POST /api/orders/:orderId/cancel`

No permite cancelar una orden `PAID`; ese caso debe pasar posteriormente por devolución/nota de crédito.

### Transferencia bancaria

`GET /api/payments/bank-accounts`

`POST /api/payments/orders/:orderId/manual-transfer`

`GET /api/payments/orders/:orderId`

`POST /api/payments/:paymentId/bank-transfer/proofs`

Campo multipart: `proof_file`.

Tipos permitidos:

- PDF
- JPG/JPEG
- PNG

Máximo 10 MB.

También existe soporte JSON Base64 en el controller actual.

### Retiro en tienda

`GET /api/pickups/orders/:orderId`

`POST /api/pickups/orders/:orderId/credential`

## 5. Flujo frontend de compra

```text
GET catálogo
  ↓
carrito local frontend
  ↓
login / registro
  ↓
POST /api/orders
  ↓
POST /api/payments/orders/:orderId/manual-transfer
  ↓
mostrar cuenta bancaria
  ↓
subir comprobante
  ↓
AWAITING_CONFIRMATION
  ↓
ADMIN aprueba
  ↓
payment = PAID
order = CONFIRMED
reserva = CONFIRMED
  ↓
DTE local PENDING preparado automáticamente
  ↓
posteriormente: emisión Relbase V2
```

## 6. Endpoints administrativos principales

Prefijo protegido: `/api/admin` con rol `ADMIN`.

Incluye CRUD de:

- categorías
- marcas
- colecciones
- productos
- imágenes
- SEO
- promociones
- inventario/safety stock

También incluye integración Relbase, preparación/preview DTE y preflight de emisión.

Pagos administrativos:

- `GET /api/payments/admin/bank-transfer-proofs`
- `GET /api/payments/admin/bank-transfer-proofs/:proofId/file` — visualización autenticada del archivo
- `PATCH /api/payments/admin/bank-transfer-proofs/:proofId/approve`
- `PATCH /api/payments/admin/bank-transfer-proofs/:proofId/reject`

Al aprobar una transferencia WEB:

1. valida que la reserva siga vigente;
2. cambia reserva `ACTIVE -> CONFIRMED`;
3. incrementa `inventory.reserved_quantity`;
4. cambia pago a `PAID`;
5. cambia orden `PENDING -> CONFIRMED`;
6. prepara `tax_documents`/`tax_document_items` localmente;
7. NO ejecuta POST DTE a Relbase.

## 7. Seguridad/configuración cerrada

- `.gitignore` corregido.
- `.env` excluido.
- `node_modules` excluido.
- `uploads` excluido.
- `.env.example` agregado.
- CORS usa whitelist por `CORS_ORIGINS`.
- JWT sigue siendo obligatorio para órdenes, pagos y retiros.
- Precios y stock nunca se confían al frontend.

## 8. Pendientes no bloqueantes para iniciar frontend

- POST real DTE Relbase V2.
- Mercado Pago/Webpay.
- Persistencia de comprobantes en object storage para producción (el driver actual sigue siendo local).
- Gestión de alta/edición de nuevas empresas desde el portal cliente, si se desea permitir FACTURA para una empresa aún no registrada.

