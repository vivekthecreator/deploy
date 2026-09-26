import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { UNIFIED_CROP_DISEASE_DATASET, matchAgainstUnifiedDataset } from './data/unifiedCropDiseaseDataset.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY is not set in environment.');
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const CANDIDATE_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.8-flash'
];

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => res.json({ status: 'online', service: 'Kisan Rakshak API' }));
app.get('/api/health', (req, res) => res.json({ status: 'online', models: CANDIDATE_MODELS }));

function parseGeminiJson(text) {
  let clean = text.trim();
  if (clean.startsWith('```json')) clean = clean.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  else if (clean.startsWith('```')) clean = clean.replace(/^```\s*/, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); }
  catch (e) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw e;
  }
}

async function callGemini(modelName, contentParts) {
  const model = genAI.getGenerativeModel({ model: modelName });
  const response = await model.generateContent(contentParts);
  const result = parseGeminiJson(response.response.text());
  console.log(`[Gemini OK] ${modelName}`);
  return { result, modelName };
}

app.post('/api/diagnose', async (req, res) => {
  const { imageBase64, crop = 'Crop', growthStage = 'Growth Stage', fieldName = 'Field', symptoms = '', weatherInfo = 'Humidity 84%' } = req.body;
  console.log(`[Scan] ${crop} | ${growthStage}`);

  const baseline = matchAgainstUnifiedDataset(crop, symptoms || crop);

  const prompt = `You are Kisan Rakshak AI. Carefully analyze the plant image and return ONLY valid JSON:
{"detectedCrop":"identify exact crop from image (Tomato/Wheat/Rice/Potato/Corn/Soybean/other)","detectedGrowthStage":"identify stage from image (Seedling/Vegetative/Flowering/Fruiting/Mature)","detectedSymptoms":["visible symptom 1 from image","visible symptom 2","visible symptom 3"],"diseaseName":"","pathogen":"","confidence":90,"severity":"Moderate","simpleExplanation":"","identifiedSymptoms":[],"immediateAction":"","precautionsAndPrevention":[],"organicRemedies":[],"chemicalTreatments":[],"weatherRiskAnalysis":"","nextScanChecklist":""}`;

  const parts = [prompt];
  if (imageBase64) {
    let b64 = imageBase64, mime = 'image/jpeg';
    if (imageBase64.includes(';base64,')) { const s = imageBase64.split(';base64,'); mime = s[0].replace('data:',''); b64 = s[1]; }
    parts.push({ inlineData: { data: b64, mimeType: mime } });
  }

  try {
    const { result, modelName } = await Promise.any(CANDIDATE_MODELS.map(m => callGemini(m, parts)));
    const rec = matchAgainstUnifiedDataset(crop, result.diseaseName || result.pathogen) || baseline;
    return res.json({
      success: true, modelUsed: modelName,
      data: {
        ...result,
        diseaseHindi: rec?.diseaseHindi||'', cropHindi: rec?.cropHindi||'',
        pathogenType: rec?.pathogenType||'Foliar Pathogen',
        benchmarkSource: rec?.benchmarkSource||'PlantVillage • CDDMBench',
        visualSignature: rec?.visualSignature||'',
        precautionsAndPrevention: result.precautionsAndPrevention?.length ? result.precautionsAndPrevention : (rec?.precautions||[]),
        organicRemedies: result.organicRemedies?.length ? result.organicRemedies : (rec?.organicTreatments||[]),
        chemicalTreatments: result.chemicalTreatments?.length ? result.chemicalTreatments : (rec?.chemicalTreatments||[]),
        favorableConditions: rec?.favorableConditions||''
      }
    });
  } catch(e) {
    if (baseline) return res.json({ success: true, modelUsed: 'Offline-Dataset', data: { diseaseName: baseline.diseaseName, pathogen: baseline.pathogen, confidence: 90, severity: baseline.severityLevel, simpleExplanation: baseline.summary, identifiedSymptoms: [baseline.visualSignature], immediateAction: baseline.immediateAction, precautionsAndPrevention: baseline.precautions, organicRemedies: baseline.organicTreatments, chemicalTreatments: baseline.chemicalTreatments, benchmarkSource: baseline.benchmarkSource } });
    return res.status(500).json({ success: false, error: 'All models unavailable' });
  }
});

app.post('/api/chat-assistant', async (req, res) => {
  const { message = '' } = req.body;
  if (!message.trim()) return res.status(400).json({ error: 'Empty message' });
  const prompt = `You are KisanRakshak, an expert agricultural AI for Indian farmers. Answer concisely in 2-3 sentences. Question: ${message}`;
  try {
    const { result, modelName } = await Promise.any(CANDIDATE_MODELS.map(async m => { const model = genAI.getGenerativeModel({model:m}); const r = await model.generateContent(prompt); return { result: r.response.text().trim(), modelName: m }; }));
    return res.json({ reply: result, modelUsed: modelName });
  } catch(e) {
    return res.json({ reply: "Please upload a crop photo using 'Diagnose My Crop' for accurate diagnosis.", modelUsed: 'Fallback' });
  }
});

app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`  Kisan Rakshak AI Server`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Models (parallel): ${CANDIDATE_MODELS.join(', ')}`);
  console.log(`=================================================`);
});
