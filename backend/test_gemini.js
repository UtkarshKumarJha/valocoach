require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function testGemini() {
    const key = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
    if (!key) {
        console.log('No GEMINI_API_KEY found');
        return;
    }
    try {
        const genAI = new GoogleGenerativeAI(key);
        const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        const model = genAI.getGenerativeModel({ model: modelName });
        
        const result = await model.generateContent('Say hello world.');
        console.log('Gemini initialized successfully. Response:');
        console.log(result.response.text());
    } catch (e) {
        console.log('Error testing Gemini: ', e);
    }
}

testGemini();
