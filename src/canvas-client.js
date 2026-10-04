async function canvasGet(pathname) {
  const response = await fetch(`${process.env.CANVAS_BASE_URL}${pathname}`, {
    headers: {
      Authorization: `Bearer ${process.env.CANVAS_ACCESS_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Canvas returned HTTP ${response.status}`);
  }

  return response.json();
}

function getNextLink(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  const nextPart = linkHeader
    .split(",")
    .find((part) => part.includes('rel="next"'));

  return nextPart?.match(/<([^>]+)>/)?.[1] || null;
}

function getCanvasPaginationUrl(nextLink, canvasBaseUrl) {
  const nextUrl = new URL(nextLink, canvasBaseUrl);

  if (nextUrl.origin !== canvasBaseUrl.origin) {
    throw new Error("Canvas pagination URL must use the configured Canvas origin");
  }

  return nextUrl.href;
}

async function canvasGetAll(pathname) {
  const canvasBaseUrl = new URL(process.env.CANVAS_BASE_URL);
  let url = `${process.env.CANVAS_BASE_URL}${pathname}`;
  const results = [];

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.CANVAS_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Canvas returned HTTP ${response.status}`);
    }

    const page = await response.json();
    results.push(...page);

    const nextLink = getNextLink(response.headers.get("link"));
    url = nextLink
      ? getCanvasPaginationUrl(nextLink, canvasBaseUrl)
      : null;
  }

  return results;
}

module.exports = { canvasGet, canvasGetAll };
