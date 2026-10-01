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

async function canvasGetAll(pathname) {
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

    url = getNextLink(response.headers.get("link"));
  }

  return results;
}

module.exports = { canvasGet, canvasGetAll };
