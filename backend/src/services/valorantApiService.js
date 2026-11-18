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
    const response = await axios.get(`${BASE_URL}/valorant/v2/mmr/${region}/${name}/${tag}`, {
      headers: getHeaders()
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching MMR for ${name}#${tag}:`, error.message);
    throw error;
  }
};

exports.fetchPlayerMatches = async (region, name, tag, size = 10) => {
  try {
    const response = await axios.get(`${BASE_URL}/valorant/v3/matches/${region}/${name}/${tag}?mode=competitive&size=${size}`, {
      headers: getHeaders()
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching matches for ${name}#${tag}:`, error.message);
    throw error;
  }
};
