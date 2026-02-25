# Fetch Links Frontend - Cloudflare Pages

This is the frontend component for the Fetch Links application, deployed on Cloudflare Pages.

## Features

- Modern, responsive user interface
- URL metadata fetching and display
- Integration with Hugging Face backend

## Deployment

1. Push your code to a GitHub repository
2. Log in to Cloudflare Dashboard
3. Go to Pages > Create a project
4. Connect your GitHub repository
5. Set the following:
   - Production branch: main
   - Build command: (leave empty for static files)
   - Build output directory: ./
6. Click "Save and Deploy"

## Configuration Files

- `_redirects` - Handles SPA routing and URL redirects
- `_headers` - Security headers and cache configuration
- `wrangler.toml` - Cloudflare Pages configuration

## Environment Variables

Set the following in your Cloudflare Pages project settings:
- `API_URL` - Your Hugging Face Space URL

## Development

To run locally:
1. Install dependencies: `npm install`
2. Start local server: `npx serve .`
3. Open `http://localhost:3000`
