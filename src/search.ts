export async function fetchSearchContext(query: string, apiKey?: string): Promise<string> {
  if (!apiKey) {
    return "";
  }

  const url = "https://api.tavily.com/search";
  const payload = {
    api_key: apiKey,
    query: query,
    search_depth: "basic",
    max_results: 3
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`Tavily API error (${response.status}): ${await response.text()}`);
      return "";
    }

    const data: any = await response.json();
    const results = data.results || [];

    if (results.length === 0) {
      return "";
    }

    const lines = results.map((r: any) => `- [${r.title}](${r.url}): ${r.content}`);
    return `Web Search Context:\n${lines.join("\n")}`;
  } catch (error) {
    console.error("Failed to fetch search context:", error);
    return "";
  }
}
