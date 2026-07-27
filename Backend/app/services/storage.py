import uuid

from fastapi import UploadFile
from firebase_admin import storage


bucket = storage.bucket()


async def upload_image(file: UploadFile) -> str:

    extension = file.filename.split(".")[-1]

    filename = f"uploads/{uuid.uuid4()}.{extension}"

    blob = bucket.blob(filename)

    blob.upload_from_file(
        file.file,
        content_type=file.content_type
    )

    blob.make_public()

    return blob.public_url