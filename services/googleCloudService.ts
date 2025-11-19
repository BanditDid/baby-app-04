import { Memory, GoogleConfig, MemoryImage } from "../types";

// Helper to safely get env vars without crashing if import.meta.env is undefined
const getEnv = (key: string): string => {
    try {
        // @ts-ignore - import.meta might be strictly typed
        return (import.meta.env && import.meta.env[key]) || '';
    } catch (e) {
        return '';
    }
};

// Configuration state - Initialize with Environment Variables from Vercel if available
let currentConfig: GoogleConfig = {
    clientId: getEnv('VITE_GOOGLE_CLIENT_ID'),
    apiKey: getEnv('VITE_GOOGLE_API_KEY'),
    spreadsheetId: getEnv('VITE_GOOGLE_SPREADSHEET_ID'),
    driveFolderId: getEnv('VITE_GOOGLE_DRIVE_FOLDER_ID')
};

let tokenClient: any;
let gapiInited = false;
let gisInited = false;

// Initialize configuration from LocalStorage or App
export const setGoogleConfig = (config: GoogleConfig) => {
    currentConfig = config;
};

export const isGoogleConfigured = () => {
    return currentConfig.clientId && currentConfig.clientId.length > 10 && 
           currentConfig.apiKey && currentConfig.apiKey.length > 10 && 
           currentConfig.spreadsheetId && currentConfig.spreadsheetId.length > 5;
};

export const resetApiState = () => {
    gapiInited = false;
    gisInited = false;
    tokenClient = undefined;
};

// Load Google API Client
export const loadGoogleApi = (onLoad: () => void) => {
  const waitForScripts = (attempts = 0) => {
    const gapi = (window as any).gapi;
    const google = (window as any).google;

    if (!gapi || !google) {
        if (attempts < 20) {
            setTimeout(() => waitForScripts(attempts + 1), 500);
        } else {
            console.error("Timeout waiting for Google Scripts to load.");
            onLoad();
        }
        return;
    }

    if (!isGoogleConfigured()) {
        // Even if not configured, we signal we are "ready" (but features won't work)
        gapiInited = true; 
        gisInited = true;
        onLoad(); 
        return;
    }

    if (!gapiInited) {
        gapi.load('client', async () => {
            try {
                await gapi.client.init({
                    apiKey: currentConfig.apiKey,
                    discoveryDocs: [
                        'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
                        'https://sheets.googleapis.com/$discovery/rest?version=v4'
                    ]
                });
                
                // Explicit load to be safe
                await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');
                await gapi.client.load('https://sheets.googleapis.com/$discovery/rest?version=v4');

                gapiInited = true;
                if (gisInited) onLoad();
            } catch (error) {
                console.error("GAPI Client Init Error:", error);
                onLoad();
            }
        });
    } else {
        if (gisInited) onLoad();
    }

    if (!gisInited) {
        try {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: currentConfig.clientId,
                scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email',
                callback: (resp: any) => {
                    console.log("Token client initialized", resp);
                },
            });
            gisInited = true;
            if (gapiInited) onLoad();
        } catch (error) {
            console.error("Token Client Init Error:", error);
            onLoad();
        }
    }
  };

  waitForScripts();
};

export const getUserProfile = async (): Promise<any> => {
    const gapi = (window as any).gapi;
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {
                Authorization: `Bearer ${gapi.client.getToken().access_token}`,
            },
        });
        return await response.json();
    } catch (error) {
        console.error("Failed to fetch user profile", error);
        throw error;
    }
};

export const validateUserAccess = async (userEmail: string): Promise<boolean> => {
    const gapi = (window as any).gapi;
    try {
        // Check 'Login' sheet, column A
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: currentConfig.spreadsheetId,
            range: 'Login!A:A', 
        });

        const rows = response.result.values;
        if (!rows || rows.length === 0) {
            console.warn("Login sheet is empty or missing.");
            return false; 
        }

        // Check if email exists in the list (case insensitive)
        const allowedEmails = rows.flat().map((email: string) => email.trim().toLowerCase());
        return allowedEmails.includes(userEmail.trim().toLowerCase());

    } catch (error: any) {
        console.error("Validation Error:", error);
        // If sheet doesn't exist, specific error handling could go here
        throw new Error("Could not verify access. Please ensure a sheet named 'Login' exists.");
    }
};

export const handleGoogleLogin = (silent: boolean = false): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (!isGoogleConfigured()) {
        return reject(new Error("Missing Google Configuration. Please go to Settings to enter your API Keys."));
    }
    if (!tokenClient) {
        // Try to re-init if missing
        loadGoogleApi(() => {});
        return reject(new Error("Google API library not ready. Please try again in a few seconds."));
    }

    tokenClient.callback = async (resp: any) => {
      if (resp.error) {
        const errorMessage = typeof resp.error === 'string' ? resp.error : JSON.stringify(resp);
        reject(new Error(`Google Login Failed: ${errorMessage}`));
        return;
      }
      resolve();
    };

    const gapi = (window as any).gapi;
    const existingToken = gapi?.client?.getToken();

    // If silent and we have a token (even if potentially expired, we rely on client lib to handle refresh flows if configured, 
    // or simplified flow here assumes we need a new token if explicit login is requested.
    // For true silent login, we skip prompting.
    if (silent && existingToken) {
        resolve();
        return;
    }

    // If prompt is needed
    if (existingToken === null) {
      tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
      tokenClient.requestAccessToken({ prompt: '' });
    }
  });
};

const base64ToBlob = (base64: string, mimeType: string) => {
  const byteCharacters = atob(base64.split(',')[1]);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
};

export const uploadImageToDrive = async (base64: string, mimeType: string, fileName: string): Promise<string> => {
  try {
    const gapi = (window as any).gapi;
    const blob = base64ToBlob(base64, mimeType);
    
    const metadata = {
      name: fileName,
      mimeType: mimeType,
      parents: currentConfig.driveFolderId ? [currentConfig.driveFolderId] : undefined
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const accessToken = gapi.client.getToken()?.access_token;
    if (!accessToken) throw new Error("No Google Access Token found. Please login again.");

    // Upload file
    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,thumbnailLink', {
      method: 'POST',
      headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
      body: form,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Drive Upload Failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // Prefer thumbnailLink (high res) for direct display if available, otherwise fall back to webViewLink
    // Note: thumbnailLink usually requires a query param to resize, e.g., =w4096 to get full size
    if (data.thumbnailLink) {
        return data.thumbnailLink.replace('=s220', '=w4096'); // Request high resolution
    }

    if (!data.webViewLink) {
        throw new Error("Drive Upload successful but links are missing.");
    }
    return data.webViewLink;

  } catch (error: any) {
    const msg = error instanceof Error ? error.message : (error?.result?.error?.message || JSON.stringify(error));
    throw new Error(`Image Upload Error: ${msg}`);
  }
};

export const appendToSheet = async (memory: Memory, imageUrls: string[]) => {
  const gapi = (window as any).gapi;
  
  const rowData = [
    memory.date,
    memory.calculatedAge,
    memory.mood,
    memory.note,
    ...imageUrls
  ];

  try {
      await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: currentConfig.spreadsheetId,
        range: 'Sheet1!A1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [rowData],
        },
      });
  } catch (error: any) {
      const msg = error instanceof Error ? error.message : (error?.result?.error?.message || JSON.stringify(error));
      throw new Error(`Sheets Append Failed: ${msg}`);
  }
};

export const getMemoriesFromSheet = async (): Promise<Memory[]> => {
    const gapi = (window as any).gapi;
    if (!currentConfig.spreadsheetId) return [];
    
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: currentConfig.spreadsheetId,
            range: 'Sheet1!A:Z', // Fetch all columns
        });

        const rows = response.result.values;
        if (!rows || rows.length === 0) return [];

        // Convert rows to Memory objects
        // Assuming Row structure: [Date, Age, Mood, Note, ImgUrl1, ImgUrl2...]
        const memories: Memory[] = rows.map((row: string[], index: number) => {
            const images: MemoryImage[] = [];
            
            // Process image URLs starting from column 5 (index 4)
            for(let i = 4; i < row.length; i++) {
                if(row[i] && row[i].startsWith('http')) {
                     images.push({
                         id: `img-${index}-${i}`,
                         base64: '', // No base64 for cloud images
                         url: row[i],
                         mimeType: 'image/jpeg'
                     });
                }
            }

            return {
                id: `sheet-${index}`,
                date: row[0],
                calculatedAge: row[1],
                mood: row[2] as any,
                note: row[3],
                images: images,
                createdAt: Date.now()
            };
        });
        
        return memories.reverse(); // Show newest first

    } catch (error) {
        console.error("Failed to fetch memories from sheet:", error);
        return [];
    }
};

export const getGapiClient = () => (window as any).gapi;