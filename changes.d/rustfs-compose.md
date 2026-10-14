---
priority: -50
links:
  '#549': https://github.com/fedify-dev/hollo/issues/549
---
 -  Replaced the archived MinIO images in the Docker Compose example with
    RustFS and the official AWS CLI image.  The setup continues to create a
    publicly readable bucket for media storage automatically.  Existing
    Compose installations can migrate their MinIO media with the provided
    migration overlay and verification command.  [[#549]]
