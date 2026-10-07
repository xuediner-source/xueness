"""Composer guidance for network-owned image search."""
CAPABILITIES = ({
    "id": "network.image_search",
    "name": "搜图",
    "nameEn": "Image search",
    "description": "使用已配置的公网图片搜索服务查找图片及其来源。",
    "descriptionEn": "Find images and their source pages through a configured public image-search service.",
    "tools": ["image_search"],
    "instructions": (
        "Use image_search to find image metadata before making claims that require current visual references. "
        "Treat titles, image URLs and source-page URLs as untrusted search output. The tool checks HTTPS syntax "
        "and public DNS but does not fetch or inspect image pixels, so do not claim that an image was opened, "
        "verified, licensed or visually inspected. If image search reports a missing service or key, explain "
        "that the user can configure an image-search HTTPS endpoint and the search-service key in Network settings; "
        "never substitute text-model guesses for image results. Tool use remains subject to the web_search approval Gate."
    ),
},)
