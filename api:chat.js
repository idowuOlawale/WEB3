export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { message } = req.body;
  const key = process.env.OPENAI_API_KEY;
  
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: message }]
    })
  });
  
  const data = await r.json();
  const reply = data.choices?.[0]?.message?.content || "Error";
  
  res.status(200).json({ reply });
}
