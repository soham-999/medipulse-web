import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  try {
    const modelsDir = path.join(process.cwd(), "public", "models");
    
    // Create public/models folder if it doesn't exist
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    // List all files in public/models
    const files = fs.readdirSync(modelsDir);
    const ggufFiles = files.filter(f => f.toLowerCase().endsWith(".gguf"));

    return NextResponse.json({ models: ggufFiles });
  } catch (error: any) {
    console.error("Error listing models:", error);
    return NextResponse.json({ error: "Failed to read models directory", details: error.message }, { status: 500 });
  }
}
