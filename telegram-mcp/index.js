#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const axios = require('axios');

const server = new Server(
    { name: 'telegram-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'tg_notify',
                description: 'Send a notification/message to the user via Telegram.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        message: { type: 'string', description: 'The message to send' }
                    },
                    required: ['message']
                }
            },
            {
                name: 'tg_ask',
                description: 'Send a question to the user via Telegram and WAIT for their reply. Use this to ask for confirmation or missing info.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        question: { type: 'string', description: 'The question to ask the user' }
                    },
                    required: ['question']
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
        if (name === 'tg_notify') {
            await axios.post('http://127.0.0.1:4141/notify', { message: args.message });
            return { content: [{ type: 'text', text: 'Message sent successfully.' }] };
        } 
        else if (name === 'tg_ask') {
            const response = await axios.post('http://127.0.0.1:4141/ask', { question: args.question }, { timeout: 0 }); // Wait indefinitely
            return { content: [{ type: 'text', text: `User replied: ${response.data.reply}` }] };
        }
        else {
            throw new Error('Unknown tool');
        }
    } catch (error) {
        return { 
            isError: true, 
            content: [{ type: 'text', text: error.response?.data?.error || error.message }] 
        };
    }
});

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

run().catch(console.error);
