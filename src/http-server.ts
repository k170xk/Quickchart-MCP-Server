#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  JSONRPCRequest,
  JSONRPCResponse,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import getenv from 'getenv';
import http from 'http';
import { URL } from 'url';

const QUICKCHART_BASE_URL = getenv('QUICKCHART_BASE_URL', 'https://quickchart.io/chart');
const PORT = getenv.int('PORT', 3000);

interface ChartConfig {
  type: string;
  data: {
    labels?: string[];
    datasets: Array<{
      label?: string;
      data: number[];
      backgroundColor?: string | string[];
      borderColor?: string | string[];
      [key: string]: any;
    }>;
    [key: string]: any;
  };
  options?: {
    title?: {
      display: boolean;
      text: string;
    };
    scales?: {
      y?: {
        beginAtZero?: boolean;
      };
    };
    [key: string]: any;
  };
}

class QuickChartServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'quickchart-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    this.server.onerror = (error) => console.error('[MCP Error]', error);
  }

  private validateChartType(type: string): void {
    const validTypes = [
      'bar', 'line', 'pie', 'doughnut', 'radar',
      'polarArea', 'scatter', 'bubble', 'radialGauge', 'speedometer'
    ];
    if (!validTypes.includes(type)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid chart type. Must be one of: ${validTypes.join(', ')}`
      );
    }
  }

  private generateChartConfig(args: any): ChartConfig {
    if (!args) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No arguments provided to generateChartConfig'
      );
    }
    
    if (!args.type) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Chart type is required'
      );
    }
    
    if (!args.datasets || !Array.isArray(args.datasets)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Datasets must be a non-empty array'
      );
    }
    
    const { type, labels, datasets, title, options = {} } = args;
    
    this.validateChartType(type);

    const config: ChartConfig = {
      type,
      data: {
        labels: labels || [],
        datasets: datasets.map((dataset: any) => {
          if (!dataset || !dataset.data) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Each dataset must have a data property'
            );
          }
          return {
            label: dataset.label || '',
            data: dataset.data,
            backgroundColor: dataset.backgroundColor,
            borderColor: dataset.borderColor,
            ...(dataset.additionalConfig || {})
          };
        })
      },
      options: {
        ...options,
        ...(title && {
          title: {
            display: true,
            text: title
          }
        })
      }
    };

    switch (type) {
      case 'radialGauge':
      case 'speedometer':
        if (!datasets?.[0]?.data?.[0]) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `${type} requires a single numeric value`
          );
        }
        config.options = {
          ...config.options,
          plugins: {
            datalabels: {
              display: true,
              formatter: (value: number) => value
            }
          }
        };
        break;

      case 'scatter':
      case 'bubble':
        datasets.forEach((dataset: any) => {
          if (!Array.isArray(dataset.data[0])) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `${type} requires data points in [x, y${type === 'bubble' ? ', r' : ''}] format`
            );
          }
        });
        break;
    }

    return config;
  }

  private async generateChartUrl(config: ChartConfig): Promise<string> {
    const encodedConfig = encodeURIComponent(JSON.stringify(config));
    return `${QUICKCHART_BASE_URL}?c=${encodedConfig}`;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'generate_chart',
          description: 'Generate a chart using QuickChart',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description: 'Chart type (bar, line, pie, doughnut, radar, polarArea, scatter, bubble, radialGauge, speedometer)'
              },
              labels: {
                type: 'array',
                items: { type: 'string' },
                description: 'Labels for data points'
              },
              datasets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    data: { type: 'array' },
                    backgroundColor: { 
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } }
                      ]
                    },
                    borderColor: {
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } }
                      ]
                    },
                    additionalConfig: { type: 'object' }
                  },
                  required: ['data']
                }
              },
              title: { type: 'string' },
              options: { type: 'object' }
            },
            required: ['type', 'datasets']
          }
        },
        {
          name: 'download_chart',
          description: 'Download a chart image to a local file',
          inputSchema: {
            type: 'object',
            properties: {
              config: {
                type: 'object',
                description: 'Chart configuration object'
              },
              outputPath: {
                type: 'string',
                description: 'Path where the chart image should be saved. If not provided, the chart will be saved to Desktop or home directory.'
              }
            },
            required: ['config']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'generate_chart': {
          try {
            const config = this.generateChartConfig(request.params.arguments);
            const url = await this.generateChartUrl(config);
            return {
              content: [
                {
                  type: 'text',
                  text: url
                }
              ]
            };
          } catch (error: any) {
            if (error instanceof McpError) {
              throw error;
            }
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to generate chart: ${error?.message || 'Unknown error'}`
            );
          }
        }

        case 'download_chart': {
          try {
            const { config, outputPath: userProvidedPath } = request.params.arguments as { 
              config: Record<string, unknown>;
              outputPath?: string;
            };
            
            if (!config || typeof config !== 'object') {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Config must be a valid chart configuration object'
              );
            }
            
            let normalizedConfig: any = { ...config };
            
            if (config.data && typeof config.data === 'object' && 
                (config.data as any).datasets && !normalizedConfig.datasets) {
              normalizedConfig.datasets = (config.data as any).datasets;
            }
            
            if (config.data && typeof config.data === 'object' && 
                (config.data as any).labels && !normalizedConfig.labels) {
              normalizedConfig.labels = (config.data as any).labels;
            }
            
            if (config.data && typeof config.data === 'object' && 
                (config.data as any).type && !normalizedConfig.type) {
              normalizedConfig.type = (config.data as any).type;
            }
            
            if (!normalizedConfig.type || !normalizedConfig.datasets) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Config must include type and datasets properties (either at root level or inside data object)'
              );
            }
            
            const chartConfig = this.generateChartConfig(normalizedConfig);
            const url = await this.generateChartUrl(chartConfig);
            
            try {
              const response = await axios.get(url, { responseType: 'arraybuffer' });
              const base64Image = Buffer.from(response.data).toString('base64');
              
              return {
                content: [
                  {
                    type: 'text',
                    text: `Chart generated successfully. Image data (base64): ${base64Image.substring(0, 100)}...`
                  },
                  {
                    type: 'image',
                    data: base64Image,
                    mimeType: 'image/png'
                  }
                ]
              };
            } catch (error: any) {
              throw error;
            }
          } catch (error: any) {
            if (error instanceof McpError) {
              throw error;
            }
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to download chart: ${error?.message || 'Unknown error'}`
            );
          }
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  async handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    try {
      const response = await this.server.handleRequest(request);
      return response;
    } catch (error: any) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: error.code || ErrorCode.InternalError,
          message: error.message || 'Internal error'
        }
      };
    }
  }
}

// HTTP Server
const mcpServer = new QuickChartServer();

const httpServer = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  
  // Health check endpoint
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'quickchart-mcp-server' }));
    return;
  }

  // MCP streaming endpoint
  if (url.pathname === '/mcp/stream') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const request: JSONRPCRequest = JSON.parse(body);
        const response = await mcpServer.handleRequest(request);
        
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: {
            code: -32603,
            message: error.message || 'Internal error'
          }
        }));
      }
    });
    return;
  }

  // List tools endpoint
  if (url.pathname === '/mcp/tools' && req.method === 'GET') {
    try {
      const request: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      };
      const response = await mcpServer.handleRequest(request);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(PORT, () => {
  console.log(`QuickChart MCP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp/stream`);
  console.log(`Tools endpoint: http://localhost:${PORT}/mcp/tools`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down server...');
  httpServer.close();
  process.exit(0);
});



