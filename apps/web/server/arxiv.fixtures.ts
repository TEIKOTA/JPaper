// arXiv API の Atom 応答の見本（テスト用）。
export const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query%3Dall%3Arashomon" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=all:rashomon</title>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">42</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2601.20627v2</id>
    <updated>2026-01-30T00:00:00Z</updated>
    <published>2026-01-28T18:00:00Z</published>
    <title>The Rashomon Set:
  Theory &amp; Practice</title>
    <summary>  We study &lt;many&gt; models &#8212; and &#x3b1;.
    </summary>
    <author>
      <name>Ada Lovelace</name>
    </author>
    <author>
      <name>Alan Turing</name>
      <arxiv:affiliation xmlns:arxiv="http://arxiv.org/schemas/atom">Cambridge</arxiv:affiliation>
    </author>
    <link href="http://arxiv.org/abs/2601.20627v2" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/hep-th/9901001v1</id>
    <published>1999-01-01T00:00:00Z</published>
    <title>Old Style</title>
    <summary>s</summary>
    <author><name>X</name></author>
  </entry>
</feed>`;
