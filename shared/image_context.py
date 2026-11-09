"""Bounded image context shared by HTTP validation and the planner."""
import base64
import binascii
from io import BytesIO
import warnings
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGES = 3
MAX_PIXELS = 20_000_000
FORMATS = {"image/png":"PNG", "image/jpeg":"JPEG", "image/webp":"WEBP"}


class ImageContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=160)
    media_type: str
    data_url: str = Field(max_length=MAX_IMAGE_BYTES * 4 // 3 + 128)

    @model_validator(mode="after")
    def validate_image(self):
        prefix = f"data:{self.media_type};base64,"
        if self.media_type not in FORMATS or not self.data_url.startswith(prefix):
            raise ValueError("Use PNG, JPEG or WebP images.")
        try:
            raw = base64.b64decode(self.data_url[len(prefix):], validate=True)
            if not raw or len(raw) > MAX_IMAGE_BYTES:
                raise ValueError("Image exceeds 2 MiB.")
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(BytesIO(raw)) as image:
                    if image.format != FORMATS[self.media_type] or image.width * image.height > MAX_PIXELS or getattr(image, "is_animated", False):
                        raise ValueError("Unsupported image dimensions or format.")
                    image.verify()
        except (binascii.Error, OSError, SyntaxError, Warning, Image.DecompressionBombError) as error:
            raise ValueError("Invalid image data.") from error
        return self

