const axios = require('axios');

const BASE_URL = 'https://api.henrikdev.xyz';

const getHeaders = () => {
  const headers = {};
  if (process.env.HENRIK_API_KEY) {
    headers['Authorization'] = process.env.HENRIK_API_KEY;
  }
  return headers;
};

exports.fetchPlayerMmr = async (region, name, tag) => {
  try {
    const response = await axios.get(`${BASE_URL}/valorant/v1/mmr/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, {
      headers: getHeaders(),
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching MMR for ${name}#${tag}:`, error.message);
    throw error;
  }
};

exports.fetchPlayerMatchesV4 = async (region, name, tag, start = 0, size = 10, platform = 'pc') => {
  try {
    const url = `${BASE_URL}/valorant/v4/matches/${encodeURIComponent(region)}/${platform}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=${size}&start=${start}`;
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 20000
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching v4 matches for ${name}#${tag} (start: ${start}):`, error.message);
    throw error;
  }
};

exports.fetchPlayerMatchesByPuuidV4 = async (region, puuid, start = 0, size = 10, platform = 'pc') => {
  try {
    const url = `${BASE_URL}/valorant/v4/by-puuid/matches/${encodeURIComponent(region)}/${platform}/${encodeURIComponent(puuid)}?size=${size}&start=${start}`;
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: 20000
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching v4 matches by puuid for ${puuid} (start: ${start}):`, error.message);
    throw error;
  }
};

// Backwards compatibility alias
exports.fetchPlayerMatches = async (region, name, tag, size = 10) => {
  return exports.fetchPlayerMatchesV4(region, name, tag, 0, size);
};
