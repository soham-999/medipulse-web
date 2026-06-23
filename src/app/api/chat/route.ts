import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { message, history, vitalsSummary } = await req.json();
    if (!message) {
      return NextResponse.json({ error: "Missing prompt message" }, { status: 400 });
    }

    console.log("MediPulse Chat: Processing prompt =", message);

    const systemPrompt = `You are MediPulse AI, a secure, expert clinical virtual assistant built into the MediPulse app.
Your role is to assist the user with health questions, symptoms, active medications, and biometric data.

Strict guidelines for your responses:
1. Short & Concise: Always keep your replies short and direct (ideal length: 2 to 4 sentences, max 100 words). Get straight to the point without verbose greetings, redundant preambles, or general conversational filler.
2. Clinical & Direct: Provide accurate, professional clinical answers.
3. User History Integration: If relevant to the user's question, refer to the provided "USER CLINICAL DATA HISTORY" (vitals and medications). For example, if they ask about blood pressure or heart rate, use the average or last readings from the logs to give a personalized and specific response.
4. No Repetitive Disclaimers: Do not append generic, repetitive medical disclaimers (e.g. "I am an AI, not a doctor...") to every message. Only mention professional guidance or seek emergency care if the query indicates a severe symptom or true emergency (like chest pain, severe shortness of breath, etc.).`;

    const contextInstruction = formatVitalsSummary(vitalsSummary);
    const fullSystemInstruction = systemPrompt + contextInstruction;

    // 1. Try local LM Studio (localhost:1234)
    try {
      console.log("MediPulse Chat: Attempting LM Studio connection...");
      
      const lmStudioMessages = [];
      // Prepend system instructions for LM Studio
      lmStudioMessages.push({ role: "system", content: fullSystemInstruction });
      
      if (history && Array.isArray(history)) {
        for (const h of history) {
          lmStudioMessages.push({
            role: h.isUser ? "user" : "assistant",
            content: h.text
          });
        }
      }
      lmStudioMessages.push({ role: "user", content: message });

      const lmResponse = await fetch("http://127.0.0.1:1234/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local-model",
          messages: lmStudioMessages,
          temperature: 0.7,
          max_tokens: 800
        }),
        // Short timeout for fast fallback
        signal: AbortSignal.timeout(3000)
      });

      if (lmResponse.ok) {
        const data = await lmResponse.json();
        const replyText = data?.choices?.[0]?.message?.content;
        if (replyText) {
          console.log("MediPulse Chat: Success via LM Studio.");
          return NextResponse.json({ reply: replyText, source: "lm-studio" });
        }
      }
      console.warn("MediPulse Chat: LM Studio returned non-ok status or empty content.");
    } catch (lmError) {
      console.log("MediPulse Chat: LM Studio unreachable, falling back to Vertex AI / Gemini...");
    }

    // 2. Fallback to Vertex AI / Gemini API (using non-streaming generateContent for full, stable responses)
    const modelId = "gemini-3.5-flash";
    const apiKey = process.env.VERTEX_AI_KEY;
    if (!apiKey) {
      console.error("MediPulse Chat: VERTEX_AI_KEY environment variable is not defined.");
      return NextResponse.json({ error: "Cloud Chat API key is not configured." }, { status: 500 });
    }
    const vertexUri = `https://aiplatform.googleapis.com/v1/publishers/google/models/${modelId}:generateContent?key=${apiKey}`;

    console.log("MediPulse Chat: Sending request to Vertex AI URI:", vertexUri);

    // Format prompt history for Gemini contents array
    const contents = [];
    if (history && Array.isArray(history)) {
      for (const h of history) {
        contents.push({
          role: h.isUser ? "user" : "model",
          parts: [{ text: h.text }]
        });
      }
    }
    contents.push({
      role: "user",
      parts: [{ text: message }]
    });

    const vertexResponse = await fetch(vertexUri, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: contents,
        systemInstruction: {
          parts: [{ text: fullSystemInstruction }]
        }
      }),
      // Increase timeout to 20 seconds to prevent client-side cuts during large answers
      signal: AbortSignal.timeout(20000)
    });

    if (!vertexResponse.ok) {
      const errText = await vertexResponse.text();
      console.error("MediPulse Chat: Vertex AI error response:", errText);
      throw new Error(`Vertex AI returned status ${vertexResponse.status}`);
    }

    const data = await vertexResponse.json();
    
    // Parse Gemini response candidates content
    let replyText = "";
    if (Array.isArray(data)) {
      replyText = data[0]?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else {
      replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    if (!replyText) {
      throw new Error("Empty response from Vertex AI / Gemini API");
    }

    console.log("MediPulse Chat: Success via Vertex AI / Gemini API (non-streaming).");
    return NextResponse.json({ reply: replyText, source: "vertex-ai" });

  } catch (error: any) {
    console.error("MediPulse Chat: Both endpoints failed.", error);
    return NextResponse.json({ 
      error: "AI service currently unavailable", 
      details: error.message 
    }, { status: 500 });
  }
}

function formatVitalsSummary(vitalsSummary: any): string {
  if (!vitalsSummary) return "";
  
  const { vitals, medications } = vitalsSummary;
  let summaryText = "\n\n=== USER CLINICAL DATA HISTORY ===\n";

  // Format Medications
  if (Array.isArray(medications) && medications.length > 0) {
    summaryText += "Active Medications:\n";
    for (const med of medications) {
      const dose = med.dosageMg ? `${med.dosageMg}mg` : "N/A";
      const freq = med.frequencyPerDay ? `${med.frequencyPerDay}x/day` : "N/A";
      summaryText += `- ${med.drugName} (Dose: ${dose}, Frequency: ${freq})\n`;
    }
  } else {
    summaryText += "No active medications recorded.\n";
  }

  summaryText += "\nRecent Vitals History (Last 7 Days):\n";
  // Format Vitals
  if (Array.isArray(vitals) && vitals.length > 0) {
    for (const v of vitals) {
      const sys = v.sysBpAvg !== null && v.sysBpAvg !== undefined ? Math.round(v.sysBpAvg) : "N/A";
      const dia = v.diaBpAvg !== null && v.diaBpAvg !== undefined ? Math.round(v.diaBpAvg) : "N/A";
      const hr = v.avgHeartRate !== null && v.avgHeartRate !== undefined ? Math.round(v.avgHeartRate) : "N/A";
      const rhr = v.restingHeartRate !== null && v.restingHeartRate !== undefined ? Math.round(v.restingHeartRate) : "N/A";
      const spo2 = v.spo2Avg !== null && v.spo2Avg !== undefined ? Math.round(v.spo2Avg) : "N/A";
      const sleep = v.sleepDurationMinutes !== null && v.sleepDurationMinutes !== undefined ? `${Math.round(v.sleepDurationMinutes)} mins` : "N/A";
      summaryText += `- ${v.date}: Avg HR: ${hr} BPM, Resting HR: ${rhr} BPM, BP: ${sys}/${dia} mmHg, SpO2: ${spo2}%, Sleep: ${sleep}\n`;
    }
  } else {
    summaryText += "No vitals history recorded.\n";
  }
  summaryText += "==================================\n";
  return summaryText;
}
