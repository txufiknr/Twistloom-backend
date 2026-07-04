# Backend Corrections

## Profile Image Upload (Avatar) — Fixed

### Problem
The frontend sends avatar images as base64 data URLs (via `FileReader.readAsDataURL`) in `PUT /user` as `imageUrl`. The backend was storing these raw base64 strings directly into the `users.image_url` column without:
- Uploading to ImageKit first
- Registering in the `uploaded_images` tracking table
- Letting the DB trigger (`ensureUploadedUserImageTrigger`) handle `users.image_url`

### Fix Applied
Changed the approach in `src/routes/user.ts:PUT /api/user` to use the `uploaded_images` + trigger architecture:

1. After `sanitizeProfileUpdate()` returns sanitized data
2. If `updateData.imageUrl` starts with `data:` (base64):
   - Call `uploadUserImage(imageUrl, userId)` to upload to ImageKit
   - Insert new `uploaded_images` row with `{ imageId, imageUrl, userId, type: 'user' }`
   - The DB trigger `set_user_image_url_from_upload()` automatically sets `users.image_url`
   - Remove `imageUrl` from `updateData` (trigger handles it)
3. Proceed with `users` UPDATE (without `imageUrl` — trigger already set it)

### Architecture
```
PUT /user (base64 imageUrl)
  → uploadUserImage()              ← uploads to ImageKit
  → insert new uploaded_images row ← trigger auto-sets users.image_url
  → update users (rest of fields)  ← image_url already correct
```

### Stale Cleanup (Cron Job)
Old user profile images are not deleted inline — instead, a daily cleanup function
`cleanupStaleUserUploads()` (in `src/cron/cleanup.ts`) finds users with multiple
`type='user'` uploaded_images rows, keeps the most recent one, deletes the rest
from ImageKit, and removes their DB rows. This avoids race conditions and keeps
the hot path fast.

### Remaining Gaps
- **POST /user (onboarding)** also goes through `sanitizeProfileUpdate` — could receive base64 `imageUrl` but has no image upload path (no current frontend flow sends image during onboarding)
