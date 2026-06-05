#contract

# Contract: Attachments REST API (story 002)

Authoritative HTTP interface for image upload and auth-checked download. Client stories 004 (compose/
attach) and 005 (inline rendering) build on exactly what is documented here. Source of truth is
`SPEC.md §10`; the persisted data model and the `PublicAttachment` wire shape come from the story-001
data contract (`../story-001-attachments-data/contracts/attachments-data.md`).

Both endpoints require a valid Bearer session token (M1 `requireAuth`). All responses are JSON except
the download success body, which is the raw image bytes.

## Authentication

Every request must send the session token minted by M1 login:

```
Authorization: Bearer <session-token>
```

Missing or invalid token → `401 { "error": "unauthorized" }` on both endpoints.

## `PublicAttachment` (success body of upload)

The upload returns the frozen story-001 `PublicAttachment` shape (camelCase). There is **no `url`
field** — the client builds the download path from `id` (see download below).

```jsonc
{
  "id": 42,                 // pass this to GET /api/attachments/:id
  "messageId": null,        // always null on upload (linked later by story 003)
  "filename": "cat.png",    // original client filename (display label only)
  "contentType": "image/png", // server-sniffed MIME, NOT the client's header
  "size": 20480,            // byte size of the stored file
  "width": 640,             // probed pixel width
  "height": 480,            // probed pixel height
  "createdAt": 1730000000000 // epoch ms
}
```

```ts
interface PublicAttachment {
  id: number;
  messageId: number | null;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number;
}
```

## Endpoint reference

| Method | Path                    | Auth   | Request                          | Success                                  |
| ------ | ----------------------- | ------ | -------------------------------- | ---------------------------------------- |
| POST   | `/api/attachments`      | Bearer | `multipart/form-data`, field `file` | `201` `PublicAttachment`                 |
| GET    | `/api/attachments/:id`  | Bearer | path `id` (integer ≥ 1)          | `200` raw image bytes (streamed)         |

## `POST /api/attachments` — upload

- **Content type:** `multipart/form-data` with a **single file part** named `file`.
- **Allowed image types:** `image/png`, `image/jpeg`, `image/gif`, `image/webp`. The type is
  determined by **byte-sniffing** the upload — the client-supplied `Content-Type` and `filename` are
  **not trusted** (filename is kept only as a display label). The stored/returned `contentType` is the
  sniffed value.
- **Size cap:** `MAX_UPLOAD_MB` (default 10 MB). Enforced by the framework while streaming; oversized
  uploads are rejected, never fully buffered.
- **Behavior:** sniffs the bytes, probes width/height, writes the file to `DATA_DIR/images/<id>`,
  records the row with `uploader_id` = the authenticated user and `message_id` = NULL (unlinked), and
  returns `201` with the full `PublicAttachment`. On any rejection, nothing is persisted to disk or the
  DB (partial writes are cleaned up).

Example:

```bash
curl -F file=@cat.png \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/attachments
# -> 201 {"id":42,"messageId":null,"filename":"cat.png","contentType":"image/png", ...}
```

### Upload errors

| Status | Body                                   | When                                                              |
| ------ | -------------------------------------- | ---------------------------------------------------------------- |
| 401    | `{ "error": "unauthorized" }`          | Missing/invalid Bearer token                                     |
| 400    | `{ "error": "not_multipart" }`         | Request is not `multipart/form-data`                             |
| 400    | `{ "error": "no_file" }`               | Multipart but no file part, or the file part is empty            |
| 400    | `{ "error": "invalid_image" }`         | Bytes are undecodable, or sniffed type is not an allowed image (e.g. PDF/SVG, or a non-image renamed `.png`) |
| 413    | `{ "error": "file_too_large" }`        | Upload exceeds `MAX_UPLOAD_MB`                                    |

## `GET /api/attachments/:id` — download

- **Path param:** `id`, integer ≥ 1. Non-integer/invalid id → `400 Bad Request` (Fastify schema
  validation, `{ "statusCode": 400, "error": "Bad Request", "message": ... }`).
- **Success:** streams the stored bytes with:
  - `Content-Type`: the **stored** (sniffed-at-upload) MIME — not re-sniffed per request.
  - `Content-Length`: the stored byte size.
- **No range requests** — the whole file is streamed; `Range` headers are ignored.

To fetch into an object URL for inline rendering (story 005):

```ts
const res = await fetch(`${baseUrl}/api/attachments/${attachment.id}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const objectUrl = URL.createObjectURL(await res.blob());
```

### Download errors

| Status | Body                                      | When                                               |
| ------ | ----------------------------------------- | -------------------------------------------------- |
| 401    | `{ "error": "unauthorized" }`             | Missing/invalid Bearer token                       |
| 404    | `{ "error": "attachment_not_found" }`     | Unknown id, **or** row exists but file is missing on disk |
| 400    | `{ "statusCode": 400, "error": "Bad Request", ... }` | Non-integer / out-of-range `id`         |
