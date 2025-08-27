const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

async function extractCompany(snippet, subject, from) {
  const prompt = `
    You are extracting the EMPLOYER NAME that the applicant applied to from a job application *confirmation* email.
    
    Use the following signals in this priority order:
    1) SUBJECT — often has "Thank you for applying to <Company>" or "Thank You for Applying to <Company>".
    2) BODY (snippet) — may say "Thank you for applying to <Company>".
    3) FROM — may be an ATS (e.g., Greenhouse/Lever/Workday) or the employer's domain.
    
    Rules:
    - Return the company the candidate applied to (the employer), NOT the ATS/platform (e.g., return "Bubble", not "Greenhouse").
    - If SUBJECT clearly contains "... applying to <Company>", prefer that exact company from SUBJECT.
    - Normalize to a clean brand form:
      - Title Case words
      - Remove common legal suffixes (Inc, LLC, Ltd, GmbH, Co., PLC, S.A., Pte. Ltd., etc) if they appear.
      - Keep meaningful parentheticals, e.g., "Amazon Web Services (AWS)" → return "Amazon Web Services (AWS)".
    - If you are unsure or the employer is not stated, return null. Do NOT guess.
    
    Return JSON ONLY in this exact schema:
    {
      "company": "Acme"  // or null if unclear
    }
    
    EXAMPLES (what to return as "company"):
    - SUBJECT: "Thank you for applying to AppLovin" → "AppLovin"
    - SUBJECT: "Thank You for Applying to Mesh!" → "Mesh"
    - SUBJECT: "Thank you for applying to Cambridge Mobile Telematics" → "Cambridge Mobile Telematics"
    - SUBJECT: "Your application has been received" + BODY: "...applying to Stripe..." → "Stripe"
    - SUBJECT: "We received your application" + BODY: "...to Goldman Sachs" → "Goldman Sachs"
    - SUBJECT: "Job alerts for you" → null
    
    NOW EXTRACT for this message:
    
    SUBJECT: ${subject ?? ""}
    FROM: ${from ?? ""}
    BODY: ${snippet ?? ""}
    `.trim();

  const result = await model.generateContent(prompt);
  let text = result.response.text();

  if (text.startsWith("```")) {
    text = text
      .replace(/```(?:json)?\s*/i, "")
      .replace(/```$/, "")
      .trim();
  }

  try {
    const json = JSON.parse(text);
    return { company: json.company || null };
  } catch (err) {
    console.error("❌ Gemini response not valid JSON:", text);
    return { company: null };
  }
}

module.exports = { extractCompany };
