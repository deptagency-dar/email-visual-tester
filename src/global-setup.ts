import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import * as dotenv from 'dotenv';
import { getEmailPreviewService } from './utils/service-factory';
import { sanitizeFilename } from './utils/filename';
import axios from 'axios';

dotenv.config();

// Shape of each preview entry saved for tests.
// QA: Each item represents one email client (e.g., Gmail, Outlook).
export interface GeneratedPreview {
  name: string;  // Human-readable label
  url: string;   // URL to the rendered email screenshot
  client: string; // Raw client identifier from the API
}

// Folder paths used throughout.
const TEMP_DIR = resolve(__dirname, '..', 'temp');
const ARCHIVE_DIR = resolve(TEMP_DIR, 'archives');
const EMAILS_DIR = resolve(__dirname, '..', 'emails');
const DEFAULT_CLIENTS_FILE = resolve(__dirname, '..', 'default-clients-eoa.json');

// MAIN ENTRY POINT: Runs once before tests.
// Generates preview URLs from the email HTML you placed in /emails/<task>.html
async function globalSetup() {
  const taskName = process.env.TASK_NAME;

  if (!taskName) {
    console.warn('WARNING: TASK_NAME is not set. No previews generated.');
    return;
  }

  // Standard naming (hyphens) used for both HTML and results JSON.
  const sanitizedTaskName = sanitizeFilename(taskName);
  const emailHtmlFileName = `${sanitizedTaskName}.html`;
  const EMAIL_HTML_FILE = resolve(EMAILS_DIR, emailHtmlFileName);
  const GENERATED_URLS_FILE = resolve(TEMP_DIR, `generated-preview-urls-${sanitizedTaskName}.json`);

  const now = new Date();
  const verboseTimestamp = now.toISOString().replace(/[:.]/g, '-').split('T').join('-');

  console.log(`--- Global Setup: Preparing previews for "${taskName}" ---`);

  // QA: If this fails, ensure the HTML file exists in /emails.
  if (!existsSync(EMAIL_HTML_FILE)) {
    throw new Error(`Missing email HTML file: ${EMAIL_HTML_FILE}`);
  }

  // Determine which email clients to request (read from JSON config).
  const desiredApiClients = getDesiredApiClients();

  // Pull credentials from environment variables.
  const { serviceToUse, apiKey, accountPassword } = getServiceCredentials();

  // Ensure output folders exist.
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

  // Read the email HTML file contents to send to the preview service.
  const emailHtmlContent = readFileSync(EMAIL_HTML_FILE, 'utf-8');

  // Instantiate the chosen preview service (currently Email on Acid).
  const previewService = getEmailPreviewService(serviceToUse, apiKey, accountPassword);

  try {
    // Subject helps identify the test in the external service dashboard.
    const emailSubject = `${taskName} - EOA Preview - ${now.toLocaleString()}`;

    // 1) Upload HTML (create a test).
    const injectionResponse = await previewService.injectHtml(emailHtmlContent, emailSubject, { clients: desiredApiClients });

    // 2) Poll until screenshot URLs are ready.
    const previewUrlsMap = await previewService.getPreviewUrls(injectionResponse, desiredApiClients);

    // 3) Convert the raw map into a friendlier array for the test file.
    const generatedPreviews: GeneratedPreview[] = Object.entries(previewUrlsMap).map(([client, url]) => ({
      name: `${client.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())} Preview`,
      url,
      client,
    }));

    // 4) Save main JSON file consumed by the test spec.
    writeFileSync(GENERATED_URLS_FILE, JSON.stringify(generatedPreviews, null, 2));
    console.log(`Saved preview list: ${GENERATED_URLS_FILE}`);

    // 5) Archive (timestamped) copy for history / debugging.
    archiveGeneratedUrls(sanitizedTaskName, verboseTimestamp, generatedPreviews);
  } catch (error) {
    // If anything goes wrong, show helpful info then fail early.
    handleError(error);
  }

  console.log('--- Global Setup Complete ---');
}

// Reads default client configuration (which email renderers to request).
function getDesiredApiClients() {
  if (!existsSync(DEFAULT_CLIENTS_FILE)) {
    throw new Error(`Missing default clients config: ${DEFAULT_CLIENTS_FILE}`);
  }

  const clientsConfigString = readFileSync(DEFAULT_CLIENTS_FILE, 'utf-8');
  const clientsConfig = JSON.parse(clientsConfigString);

  // Returns an array of client IDs (e.g., ["gmail_webmail", "outlook_2021"])
  return Object.values(clientsConfig).map((client: any) => client.id);
}

// Fetch credentials and validate presence.
// QA: If this fails, check .env or environment exports.
function getServiceCredentials() {
  const serviceToUse = process.env.EMAIL_PREVIEW_SERVICE?.toLowerCase();
  const apiKey = process.env[`${serviceToUse?.toUpperCase()}_API_KEY`];
  const accountPassword = process.env.EMAILONACID_ACCOUNT_PASSWORD;

  if (!serviceToUse || !apiKey || !accountPassword) {
    throw new Error('Missing EMAIL_PREVIEW_SERVICE, API key, or EOA password.');
  }

  return { serviceToUse, apiKey, accountPassword };
}

// Saves an archive copy with a timestamp (for later comparison / audits).
function archiveGeneratedUrls(sanitizedTaskName: string, verboseTimestamp: string, generatedPreviews: GeneratedPreview[]) {
  const archiveFileName = `generated-preview-urls-${sanitizedTaskName}-${verboseTimestamp}.json`;
  const archiveFilePath = resolve(ARCHIVE_DIR, archiveFileName);
  writeFileSync(archiveFilePath, JSON.stringify(generatedPreviews, null, 2));
  console.log(`Archived: ${archiveFilePath}`);
}

// Centralized error reporting with optional API response data when available.
function handleError(error: any) {
  console.error('Setup error:', error.message);
  if (axios.isAxiosError(error) && error.response) {
    console.error('API response body:', JSON.stringify(error.response.data, null, 2));
  }
  throw new Error(`Preview generation failed: ${error.message}`);
}

export default globalSetup;