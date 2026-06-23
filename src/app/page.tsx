"use client";

import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { 
  AlertTriangle, 
  FileText, 
  Lock, 
  Key, 
  ArrowRight, 
  Layers,
  Heart,
  Moon,
  Cpu,
  Camera,
  StopCircle,
  ShieldCheck
} from "lucide-react";
import { deriveKeysFromCode, decryptPayload } from "../crypto/decryptor";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid } from "recharts";
import { Html5Qrcode } from "html5-qrcode";

const safeAtob = (str: string): string => {
  const padded = str.padEnd(str.length + (4 - str.length % 4) % 4, "=");
  return atob(padded);
};

// Mock data to load immediately for demonstration / local testing
const MOCK_REPORT = {
  patientId: "9B1DEB4D",
  timeframe: "Last 7 Days",
  generatedAt: "2026-06-17T21:15:00Z",
  vitals: [
    { date: "06-11", avgHeartRate: 72, restingHeartRate: 64, hrvMs: 55, sleepMinutes: 420, screenMinutes: 45 },
    { date: "06-12", avgHeartRate: 74, restingHeartRate: 65, hrvMs: 58, sleepMinutes: 440, screenMinutes: 60 },
    { date: "06-13", avgHeartRate: 70, restingHeartRate: 63, hrvMs: 61, sleepMinutes: 490, screenMinutes: 30 },
    { date: "06-14", avgHeartRate: 85, restingHeartRate: 78, hrvMs: 38, sleepMinutes: 310, screenMinutes: 180 }, // Anomaly Day
    { date: "06-15", avgHeartRate: 58, restingHeartRate: 48, hrvMs: 65, sleepMinutes: 520, screenMinutes: 15 },
    { date: "06-16", avgHeartRate: 54, restingHeartRate: 46, hrvMs: 70, sleepMinutes: 530, screenMinutes: 20 },
    { date: "06-17", avgHeartRate: 55, restingHeartRate: 45, hrvMs: 72, sleepMinutes: 540, screenMinutes: 25 }
  ],
  medications: [
    { name: "Metoprolol Succinate", dose: "25mg", frequency: "Once Daily", startDate: "2026-06-15", source: "OCR Scan" },
    { name: "Lisinopril", dose: "10mg", frequency: "Once Daily", startDate: "2026-05-15", source: "Manual Input" }
  ],
  anomalies: [
    { 
      timestamp: 1781488800000,
      metric: "Heart Rate Spike", 
      value: "142 bpm (Resting)", 
      note: "Unusually high resting heart rate correlated with 180 mins late-night screen activity (3:15 AM sleep onset)." 
    },
    { 
      timestamp: 1781575200000,
      metric: "Bradycardia", 
      value: "45 bpm (Resting)", 
      note: "Resting heart rate dropped below 50 bpm within 24 hours of Metoprolol Succinate initiation. Known side effect; patient is stable." 
    }
  ]
};

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<any>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [scanning, setScanning] = useState(false);
  
  const fetchedRef = useRef(false);
  const qrReaderRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    setMounted(true);
    
    // Parse URL hash parameters if accessed via QR Code or direct link
    const hash = window.location.hash;
    if (hash && hash.length > 1) {
      const hashContent = hash.substring(1);
      
      // Check for legacy key/id format
      if (hashContent.includes("key=") && hashContent.includes("id=")) {
        const parts = hashContent.split("&");
        const keyPart = parts.find(p => p.startsWith("key="));
        const idPart = parts.find(p => p.startsWith("id="));
        
        if (keyPart && idPart) {
          const keyHex = keyPart.split("=")[1];
          const uuid = idPart.split("=")[1];
          if (!fetchedRef.current) {
            fetchedRef.current = true;
            fetchAndDecryptFromRelay(uuid, keyHex);
          }
        }
      } else {
        // Assume direct access code
        const cleanCode = hashContent.replace(/[^A-Za-z2-9]/g, "").toUpperCase();
        if (cleanCode.length === 9) {
          setCode(formatCodeWithDashes(hashContent.toUpperCase()));
          if (!fetchedRef.current) {
            fetchedRef.current = true;
            fetchAndDecryptFromCode(cleanCode);
          }
        }
      }
    }

    return () => {
      if (qrReaderRef.current && qrReaderRef.current.isScanning) {
        qrReaderRef.current.stop().catch(console.error);
      }
    };
  }, []);

  const formatCodeWithDashes = (val: string): string => {
    const clean = val.replace(/-/g, "");
    if (clean.length > 3 && clean.length <= 6) {
      return `${clean.slice(0, 3)}-${clean.slice(3)}`;
    } else if (clean.length > 6) {
      return `${clean.slice(0, 3)}-${clean.slice(3, 6)}-${clean.slice(6, 9)}`;
    }
    return clean;
  };

  const fetchAndDecryptFromRelay = async (uuid: string, keyHex: string) => {
    setLoading(true);
    setError(null);
    try {
      setStatusMessage("Retrieving encrypted report...");
      const response = await fetch(`/api/reports?hash=${uuid}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Report not found or has expired (1-hour link validity exceeded).");
        }
        if (response.status === 429) {
          throw new Error("Access locked due to excessive failed attempts. Try again in 24 hours.");
        }
        throw new Error("Relay server returned an error.");
      }

      const { encrypted_payload } = await response.json();
      
      setStatusMessage("Deriving cryptographic keys...");
      const keyBytes = new Uint8Array(keyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
      const cryptoKey = await window.crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM" },
        false,
        ["decrypt"]
      );

      setStatusMessage("Decrypting payload in memory...");
      const binaryString = safeAtob(encrypted_payload);
      const encryptedBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        encryptedBytes[i] = binaryString.charCodeAt(i);
      }
      
      const iv = encryptedBytes.slice(0, 12);
      const ciphertext = encryptedBytes.slice(12);

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv, tagLength: 128 },
        cryptoKey,
        ciphertext
      );

      const decrypted = JSON.parse(new TextDecoder("utf-8").decode(decryptedBuffer));
      setReport(decrypted);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Decryption failed.");
    } finally {
      setLoading(false);
    }
  };

  const fetchAndDecryptFromCode = async (cleanCode: string) => {
    setLoading(true);
    setError(null);
    try {
      setStatusMessage("Deriving keys and hashing code...");
      const { key, lookupHash } = await deriveKeysFromCode(cleanCode);

      setStatusMessage("Fetching payload from relay...");
      const response = await fetch(`/api/reports?hash=${lookupHash}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Invalid code, or report has expired.");
        }
        if (response.status === 429) {
          throw new Error("Rate limit exceeded. Your IP has been locked out.");
        }
        throw new Error("Server communication error.");
      }

      const { encrypted_payload } = await response.json();

      setStatusMessage("Decrypting clinical record...");
      const binaryString = safeAtob(encrypted_payload);
      const encryptedBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        encryptedBytes[i] = binaryString.charCodeAt(i);
      }
      
      const iv = encryptedBytes.slice(0, 12);
      const ciphertext = encryptedBytes.slice(12);

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv, tagLength: 128 },
        key,
        ciphertext
      );

      const decrypted = JSON.parse(new TextDecoder("utf-8").decode(decryptedBuffer));
      setReport(decrypted);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Decryption failed. Please check the code.");
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let input = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "");
    setCode(formatCodeWithDashes(input));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = code.replace(/-/g, "");
    if (cleanCode.length !== 9) {
      setError("Please enter a valid 9-character code.");
      return;
    }
    await fetchAndDecryptFromCode(cleanCode);
  };

  const startScanning = async () => {
    setScanning(true);
    setError(null);
    setTimeout(async () => {
      try {
        const qrScanner = new Html5Qrcode("reader");
        qrReaderRef.current = qrScanner;
        await qrScanner.start(
          { facingMode: "environment" },
          {
            fps: 15,
            qrbox: { width: 220, height: 220 }
          },
          (decodedText) => {
            stopScanning();
            handleScannedResult(decodedText);
          },
          () => {
            // Scanner feedback loop, ignore
          }
        );
      } catch (err: any) {
        console.error(err);
        setError("Camera permission denied or camera is not available.");
        setScanning(false);
      }
    }, 150);
  };

  const stopScanning = async () => {
    if (qrReaderRef.current && qrReaderRef.current.isScanning) {
      try {
        await qrReaderRef.current.stop();
      } catch (e) {
        console.error(e);
      }
    }
    qrReaderRef.current = null;
    setScanning(false);
  };

  const handleScannedResult = (text: string) => {
    try {
      let codePart = text;
      // Strip URL fragment if full URL was scanned
      if (text.includes("#")) {
        codePart = text.substring(text.indexOf("#") + 1);
      }
      
      const cleanCode = codePart.replace(/[^A-Za-z2-9]/g, "").toUpperCase();
      if (cleanCode.length === 9) {
        setCode(formatCodeWithDashes(codePart.toUpperCase()));
        fetchAndDecryptFromCode(cleanCode);
      } else {
        setError("Scanned QR code does not contain a valid 9-digit access key.");
      }
    } catch (e) {
      setError("Failed to parse scanned QR code.");
    }
  };

  const loadDemoMode = () => {
    setLoading(true);
    setError(null);
    setStatusMessage("Simulating decryption key derivation...");
    setTimeout(() => {
      setReport(MOCK_REPORT);
      setLoading(false);
    }, 600);
  };

  if (!mounted) return null;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg-obsidian)", color: "var(--text-primary)" }}>
      {/* Header Bar */}
      <header style={{
        padding: "16px 24px",
        borderBottom: "1px solid var(--border-slate)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "var(--bg-panel)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
        position: "sticky",
        top: 0,
        zIndex: 100
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: "40px",
            height: "40px",
            borderRadius: "10px",
            overflow: "hidden",
            flexShrink: 0
          }}>
            <Image
              src="/logo.png"
              alt="MediPulse Logo"
              width={40}
              height={40}
              style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "10px" }}
            />
          </div>
          <div>
            <span style={{ fontSize: "20px", fontWeight: "800", fontFamily: "Outfit, sans-serif", color: "var(--text-primary)" }}>MediPulse</span>
            <span style={{ 
              fontSize: "9px", 
              background: "var(--accent-emerald-dark)", 
              color: "var(--accent-emerald)", 
              padding: "2px 6px", 
              borderRadius: "6px",
              marginLeft: "8px",
              border: "1px solid rgba(0, 168, 132, 0.2)",
              fontWeight: "bold",
              verticalAlign: "middle"
            }}>PORTAL</span>
          </div>
        </div>
        
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
          <Lock size={13} style={{ color: "var(--accent-emerald)" }} />
          <span style={{ display: "inline" }}>End-to-End Encrypted</span>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ 
        flex: 1, 
        display: "flex", 
        flexDirection: "column", 
        padding: "24px 16px", 
        maxWidth: "1200px", 
        margin: "0 auto", 
        width: "100%",
        boxSizing: "border-box"
      }}>
        {!report ? (
          /* Landing Screen (Enter Access Code or Scan QR) */
          <div style={{ margin: "auto", width: "100%", maxWidth: "460px", padding: "16px 0" }}>
            <div className="glass-panel" style={{ padding: "32px 24px", textAlign: "center" }}>
              <div style={{
                display: "inline-flex",
                padding: "16px",
                borderRadius: "50%",
                background: "var(--accent-emerald-glow)",
                color: "var(--accent-emerald)",
                marginBottom: "20px"
              }}>
                <ShieldCheck size={36} />
              </div>
              
              <h2 style={{ fontSize: "22px", marginBottom: "8px", color: "var(--text-primary)", fontFamily: "Outfit, sans-serif" }}>Clinical Dashboard</h2>
              <p style={{ color: "var(--text-secondary)", fontSize: "13px", lineHeight: "1.5", marginBottom: "28px" }}>
                Scan the patient's sharing QR code or enter their 9-character access key to decrypt the offline vital metrics locally.
              </p>

              {scanning ? (
                /* Scanning Panel */
                <div style={{ marginBottom: "20px" }}>
                  <div className="scanner-container" style={{ width: "100%", height: "260px" }}>
                    <div className="scanner-frame-overlay"></div>
                    <div className="scanner-laser-line"></div>
                    <div id="reader" style={{ width: "100%", height: "100%" }}></div>
                  </div>
                  <div style={{ height: "16px" }} />
                  <button 
                    onClick={stopScanning}
                    className="btn-primary"
                    style={{ background: "var(--alert-critical)", color: "white", width: "100%" }}
                  >
                    <StopCircle size={18} />
                    <span>Stop Camera</span>
                  </button>
                </div>
              ) : (
                /* Standard Inputs */
                <form onSubmit={handleSubmit}>
                  <div style={{ marginBottom: "20px" }}>
                    <label style={{
                      display: "block",
                      textAlign: "left",
                      fontSize: "11px",
                      fontWeight: "bold",
                      textTransform: "uppercase",
                      color: "var(--text-secondary)",
                      marginBottom: "6px",
                      letterSpacing: "0.5px"
                    }}>
                      Patient Sync Key
                    </label>
                    <input
                      type="text"
                      value={code}
                      onChange={handleInputChange}
                      placeholder="XXX-XXX-XXX"
                      maxLength={11}
                      disabled={loading}
                      className="code-input-field"
                    />
                  </div>

                  {error && (
                    <div style={{ 
                      display: "flex", 
                      alignItems: "flex-start", 
                      gap: "10px", 
                      background: "rgba(241, 92, 109, 0.1)", 
                      border: "1px solid rgba(241, 92, 109, 0.2)", 
                      padding: "12px", 
                      borderRadius: "10px", 
                      color: "var(--alert-critical)", 
                      fontSize: "13px",
                      marginBottom: "20px",
                      textAlign: "left",
                      lineHeight: "1.4"
                    }}>
                      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: "2px" }} />
                      <span>{error}</span>
                    </div>
                  )}

                  {loading ? (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", margin: "24px 0" }}>
                      <div className="shimmer" style={{ width: "32px", height: "32px", borderRadius: "50%" }}></div>
                      <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{statusMessage}</span>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      <button type="submit" className="btn-primary" style={{ width: "100%" }}>
                        <span>Decrypt & Load Records</span>
                        <ArrowRight size={16} />
                      </button>

                      <button 
                        type="button" 
                        onClick={startScanning} 
                        className="btn-secondary" 
                        style={{ width: "100%" }}
                      >
                        <Camera size={18} />
                        <span>Scan Sharing QR Code</span>
                      </button>
                    </div>
                  )}
                </form>
              )}

              <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid var(--border-slate)" }}>
                <button 
                  onClick={loadDemoMode} 
                  disabled={loading}
                  className="btn-secondary"
                  style={{
                    padding: "10px 16px",
                    fontSize: "13px",
                    width: "100%"
                  }}
                >
                  <Cpu size={14} />
                  <span>Load Interactive Demo Report</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Report Dashboard Screen */
          <div style={{ display: "flex", flexDirection: "column", gap: "24px", animation: "fadeIn 0.5s ease-out" }}>
            
            {/* Patient Metadata Card */}
            <div className="glass-panel" style={{ 
              padding: "20px 24px", 
              display: "flex", 
              flexWrap: "wrap", 
              justifyContent: "space-between", 
              alignItems: "center", 
              gap: "16px"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                <div style={{ 
                  background: "var(--accent-emerald-glow)", 
                  color: "var(--accent-emerald)", 
                  padding: "12px", 
                  borderRadius: "12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}>
                  <FileText size={24} />
                </div>
                <div>
                  <h1 style={{ fontSize: "20px", fontFamily: "Outfit, sans-serif", color: "var(--text-primary)" }}>Clinical Summary</h1>
                  <p style={{ color: "var(--text-secondary)", fontSize: "13px", marginTop: "4px" }}>
                    Patient ID: <span style={{ fontFamily: "JetBrains Mono", color: "var(--text-primary)", fontWeight: "bold" }}>#{report.patientId}</span> • Timeframe: {report.timeframe}
                  </p>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ 
                  background: "var(--bg-obsidian)", 
                  border: "1px solid var(--border-slate)", 
                  borderRadius: "8px", 
                  padding: "6px 12px", 
                  fontSize: "11px", 
                  color: "var(--text-secondary)",
                  fontFamily: "JetBrains Mono"
                }}>
                  DEC: {new Date(report.generatedAt).toLocaleTimeString()}
                </div>
                <button 
                  onClick={() => { setReport(null); setCode(""); }}
                  style={{
                    background: "rgba(241, 92, 109, 0.1)",
                    color: "var(--alert-critical)",
                    border: "1px solid rgba(241, 92, 109, 0.2)",
                    borderRadius: "8px",
                    padding: "6px 14px",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: "600",
                    transition: "var(--transition-smooth)"
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(241, 92, 109, 0.2)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(241, 92, 109, 0.1)";
                  }}
                >
                  Purge Session
                </button>
              </div>
            </div>

            {/* Main Dashboard Grid */}
            <div className="dashboard-grid">
              
              {/* Left Column: Alerts and Medications */}
              <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
                
                {/* Alerts/Anomalies Card */}
                <div className="glass-panel" style={{ padding: "24px" }}>
                  <h3 style={{ 
                    fontSize: "16px", 
                    color: "var(--alert-critical)", 
                    marginBottom: "16px", 
                    display: "flex", 
                    alignItems: "center", 
                    gap: "8px",
                    borderBottom: "1px solid var(--border-slate)",
                    paddingBottom: "12px"
                  }}>
                    <AlertTriangle size={18} />
                    <span>Clinical Anomalies & Indicators</span>
                  </h3>
                  
                  <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    {report.anomalies && report.anomalies.length > 0 ? (
                      report.anomalies.map((anomaly: any, i: number) => (
                        <div key={i} style={{ 
                          background: "var(--bg-obsidian)", 
                          borderLeft: `4px solid ${anomaly.metric.includes("Spike") ? "var(--alert-warning)" : "var(--alert-critical)"}`,
                          padding: "16px",
                          borderRadius: "0 8px 8px 0",
                          borderTop: "1px solid var(--border-slate)",
                          borderRight: "1px solid var(--border-slate)",
                          borderBottom: "1px solid var(--border-slate)"
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                            <strong style={{ color: "var(--text-primary)" }}>{anomaly.metric}</strong>
                            <span style={{ fontFamily: "JetBrains Mono", color: "var(--alert-critical)", fontWeight: "700" }}>{anomaly.value}</span>
                          </div>
                          <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "8px", lineHeight: "1.4" }}>
                            {anomaly.note}
                          </p>
                        </div>
                      ))
                    ) : (
                      <div style={{ color: "var(--text-secondary)", fontSize: "13px", padding: "12px", textAlign: "center" }}>
                        No physiological anomalies detected.
                      </div>
                    )}
                  </div>
                </div>

                {/* Medications Card */}
                <div className="glass-panel" style={{ padding: "24px" }}>
                  <h3 style={{ 
                    fontSize: "16px", 
                    color: "var(--accent-emerald)", 
                    marginBottom: "16px", 
                    display: "flex", 
                    alignItems: "center", 
                    gap: "8px",
                    borderBottom: "1px solid var(--border-slate)",
                    paddingBottom: "12px"
                  }}>
                    <Layers size={18} />
                    <span>Prescribed Medications (Verified)</span>
                  </h3>
                  
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {report.medications && report.medications.length > 0 ? (
                      report.medications.map((med: any, i: number) => (
                        <div key={i} style={{ 
                          display: "flex", 
                          justifyContent: "space-between", 
                          alignItems: "center",
                          background: "var(--bg-obsidian)", 
                          padding: "14px 16px", 
                          borderRadius: "8px",
                          border: "1px solid var(--border-slate)"
                        }}>
                          <div>
                            <strong style={{ fontSize: "14px", color: "var(--text-primary)" }}>{med.name}</strong>
                            <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
                              Dose: {med.dose} • {med.frequency}
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
                            <span style={{ 
                              fontSize: "10px", 
                              background: "var(--accent-emerald-dark)", 
                              color: "var(--accent-emerald)", 
                              padding: "2px 8px", 
                              borderRadius: "4px",
                              fontWeight: "bold"
                            }}>
                              {med.source}
                            </span>
                            <span style={{ fontSize: "10px", color: "var(--text-secondary)" }}>
                              Init: {med.startDate}
                            </span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div style={{ color: "var(--text-secondary)", fontSize: "13px", padding: "12px", textAlign: "center" }}>
                        No active medication records.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Right Column: Heart Rate & Sleep Trends */}
              <div className="glass-panel" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "24px" }}>
                <div>
                  <h3 style={{ fontSize: "16px", marginBottom: "4px", display: "flex", alignItems: "center", gap: "8px", color: "var(--text-primary)" }}>
                    <Heart size={18} style={{ color: "var(--alert-critical)" }} />
                    <span>Heart Rate Trends & Milestones</span>
                  </h3>
                  <p style={{ color: "var(--text-secondary)", fontSize: "12px" }}>Daily resting and average heart rate (bpm) relative to Metoprolol Succinate start date.</p>
                </div>

                <div style={{ width: "100%", height: "230px" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={report.vitals} margin={{ top: 10, right: 5, left: -25, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorAvg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--accent-emerald)" stopOpacity={0.25}/>
                          <stop offset="95%" stopColor="var(--accent-emerald)" stopOpacity={0}/>
                        </linearGradient>
                        <linearGradient id="colorRest" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25}/>
                          <stop offset="95%" stopColor="#3B82F6" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-slate)" vertical={false} />
                      <XAxis dataKey="date" stroke="var(--text-secondary)" style={{ fontSize: "11px", fontFamily: "JetBrains Mono" }} />
                      <YAxis stroke="var(--text-secondary)" domain={[40, 100]} style={{ fontSize: "11px", fontFamily: "JetBrains Mono" }} />
                      <Tooltip 
                        contentStyle={{ background: "var(--bg-panel)", border: "1px solid var(--border-slate)", borderRadius: "8px", color: "var(--text-primary)" }}
                        labelStyle={{ color: "var(--text-secondary)", fontFamily: "JetBrains Mono", fontWeight: "bold" }}
                      />
                      <Area type="monotone" dataKey="avgHeartRate" name="Average HR" stroke="var(--accent-emerald)" strokeWidth={2} fillOpacity={1} fill="url(#colorAvg)" />
                      <Area type="monotone" dataKey="restingHeartRate" name="Resting HR" stroke="#3B82F6" strokeWidth={2} fillOpacity={1} fill="url(#colorRest)" />
                      
                      {report.vitals.some((d: any) => d.date === "06-15") && (
                        <ReferenceLine x="06-15" stroke="var(--alert-critical)" strokeDasharray="3 3" label={{ value: "Metoprolol Succinate", fill: "var(--alert-critical)", position: "top", fontSize: 10, fontWeight: "bold" }} />
                      )}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                <div style={{ borderTop: "1px solid var(--border-slate)", paddingTop: "20px" }}>
                  <h3 style={{ fontSize: "16px", marginBottom: "4px", display: "flex", alignItems: "center", gap: "8px", color: "var(--text-primary)" }}>
                    <Moon size={18} style={{ color: "#8B5CF6" }} />
                    <span>Sleep vs. Late-Night Screen Activity</span>
                  </h3>
                  <p style={{ color: "var(--text-secondary)", fontSize: "12px" }}>Visual correlation between late-night phone screen times and actual sleep duration (mins).</p>
                </div>

                <div style={{ width: "100%", height: "200px" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={report.vitals} margin={{ top: 10, right: 5, left: -25, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorSleep" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.25}/>
                          <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0}/>
                        </linearGradient>
                        <linearGradient id="colorScreen" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.25}/>
                          <stop offset="95%" stopColor="#F59E0B" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-slate)" vertical={false} />
                      <XAxis dataKey="date" stroke="var(--text-secondary)" style={{ fontSize: "11px", fontFamily: "JetBrains Mono" }} />
                      <YAxis stroke="var(--text-secondary)" style={{ fontSize: "11px", fontFamily: "JetBrains Mono" }} />
                      <Tooltip 
                        contentStyle={{ background: "var(--bg-panel)", border: "1px solid var(--border-slate)", borderRadius: "8px", color: "var(--text-primary)" }}
                        labelStyle={{ color: "var(--text-secondary)", fontFamily: "JetBrains Mono", fontWeight: "bold" }}
                      />
                      <Area type="monotone" dataKey="sleepMinutes" name="Sleep (min)" stroke="#8B5CF6" strokeWidth={2} fillOpacity={1} fill="url(#colorSleep)" />
                      <Area type="monotone" dataKey="screenMinutes" name="Night Screen (min)" stroke="#F59E0B" strokeWidth={2} fillOpacity={1} fill="url(#colorScreen)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

              </div>

            </div>

          </div>
        )}
      </main>

      <footer style={{
        padding: "20px 24px",
        borderTop: "1px solid var(--border-slate)",
        textAlign: "center",
        fontSize: "12px",
        color: "var(--text-secondary)",
        background: "var(--bg-panel)",
        marginTop: "auto"
      }}>
        MediPulse Health Platform • Zero-knowledge browser sandbox client-side decryption.
      </footer>
    </div>
  );
}
