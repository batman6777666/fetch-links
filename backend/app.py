"""
Hugging Face Backend - Flask API
This is the backend API for fetching link metadata
"""

from flask import Flask, request, jsonify
import requests
import os

app = Flask(__name__)


def fetch_metadata(url: str):
    """
    Fetch metadata from a URL
    
    Args:
        url: The URL to fetch metadata from
        
    Returns:
        Dictionary containing metadata
    """
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        
        html_content = response.text
        
        # Extract title
        title = ""
        if "<title>" in html_content:
            start = html_content.find("<title>") + 7
            end = html_content.find("</title>")
            title = html_content[start:end].strip()
        
        # Extract meta description
        description = ""
        if 'name="description"' in html_content:
            start = html_content.find('content="', html_content.find('name="description"')) + 9
            end = html_content.find('"', start)
            description = html_content[start:end].strip()
        
        # Extract og:image
        image = ""
        if 'property="og:image"' in html_content:
            start = html_content.find('content="', html_content.find('property="og:image"')) + 9
            end = html_content.find('"', start)
            image = html_content[start:end].strip()
        
        return {
            "success": True,
            "url": url,
            "title": title,
            "description": description,
            "image": image,
            "status_code": response.status_code
        }
        
    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "url": url,
            "error": str(e)
        }
    except Exception as e:
        return {
            "success": False,
            "url": url,
            "error": f"Unexpected error: {str(e)}"
        }


@app.route('/fetch', methods=['POST'])
def fetch_links():
    """
    API endpoint to fetch metadata for multiple URLs
    
    Expects JSON payload with 'urls' field containing a list of URLs
    """
    data = request.get_json()
    
    if not data or 'urls' not in data:
        return jsonify({"error": "Please provide 'urls' field in JSON payload"}), 400
    
    urls = data['urls']
    
    if not isinstance(urls, list):
        return jsonify({"error": "'urls' must be a list"}), 400
    
    results = [fetch_metadata(url) for url in urls]
    
    return jsonify(results)


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "healthy"})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7860))
    app.run(host='0.0.0.0', port=port)
