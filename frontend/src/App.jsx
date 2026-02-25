import { useState } from 'react'

function App() {
    const [urls, setUrls] = useState('')
    const [results, setResults] = useState(null)
    const [loading, setLoading] = useState(false)

    // Replace with your Hugging Face Space URL
    const API_URL = 'https://your-huggingface-space.hf.space/fetch'

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (!urls.trim()) return

        setLoading(true)
        try {
            const urlList = urls.split('\n').filter(u => u.trim())
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ urls: urlList }),
            })
            const data = await response.json()
            setResults(data)
        } catch (error) {
            console.error('Error:', error)
            setResults({ error: 'Failed to fetch metadata' })
        }
        setLoading(false)
    }

    return (
        <div className="container">
            <h1>Fetch Links</h1>
            <form onSubmit={handleSubmit}>
                <textarea
                    value={urls}
                    onChange={(e) => setUrls(e.target.value)}
                    placeholder="Enter URLs (one per line)"
                    rows={10}
                />
                <button type="submit" disabled={loading}>
                    {loading ? 'Fetching...' : 'Fetch Metadata'}
                </button>
            </form>

            {results && (
                <div className="results">
                    <pre>{JSON.stringify(results, null, 2)}</pre>
                </div>
            )}
        </div>
    )
}

export default App
