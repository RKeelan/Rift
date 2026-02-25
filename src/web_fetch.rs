use reqwest::Client;
use url::Url;

use crate::error::ImpError;

/// Maximum response body size in bytes (1 MB).
const MAX_BODY_BYTES: usize = 1_048_576;

/// Maximum plain-text output length in bytes returned to the agent.
const MAX_TEXT_BYTES: usize = 50_000;

/// Fetch a URL and return its content as plain text.
///
/// Validates the URL's domain against `allowed_domains`. An empty whitelist
/// permits all domains. HTML responses are converted to plain text; other
/// content types are returned as-is (truncated if necessary).
pub async fn fetch_url(
    client: &Client,
    url: &str,
    allowed_domains: &[String],
) -> Result<String, ImpError> {
    let parsed = Url::parse(url).map_err(|e| ImpError::WebFetch(format!("invalid URL: {e}")))?;

    let host = parsed
        .host_str()
        .ok_or_else(|| ImpError::WebFetch("URL has no host".to_string()))?;

    if !allowed_domains.is_empty() {
        let host_lower = host.to_lowercase();
        let allowed = allowed_domains
            .iter()
            .any(|d| host_lower == *d || host_lower.ends_with(&format!(".{d}")));
        if !allowed {
            return Err(ImpError::WebFetch(format!(
                "domain '{host}' is not in the allowed list"
            )));
        }
    }

    let response = client
        .get(url)
        .header("User-Agent", "Imp/1.0")
        .send()
        .await
        .map_err(|e| ImpError::WebFetch(format!("request failed: {e}")))?;

    let status = response.status();
    if status.is_redirection() {
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown");
        return Err(ImpError::WebFetch(format!(
            "redirect to {location} (redirects are not followed for security)"
        )));
    }
    if !status.is_success() {
        return Err(ImpError::WebFetch(format!("HTTP {status} fetching {url}")));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    if let Some(len) = response.content_length() {
        if len > MAX_BODY_BYTES as u64 {
            return Err(ImpError::WebFetch(format!(
                "response too large ({len} bytes, max {MAX_BODY_BYTES})"
            )));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| ImpError::WebFetch(format!("failed to read response body: {e}")))?;

    if bytes.len() > MAX_BODY_BYTES {
        return Err(ImpError::WebFetch(format!(
            "response too large ({} bytes, max {MAX_BODY_BYTES})",
            bytes.len()
        )));
    }

    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| ImpError::WebFetch("response is not valid UTF-8".to_string()))?;

    let text = if content_type.contains("text/html") {
        html2text::from_read(body.as_bytes(), 80)
            .map_err(|e| ImpError::WebFetch(format!("HTML conversion failed: {e}")))?
    } else {
        body
    };

    Ok(truncate(&text, MAX_TEXT_BYTES))
}

/// Truncate text to at most `max_bytes` bytes, appending a notice if truncated.
/// Finds the nearest UTF-8 character boundary to avoid splitting multi-byte characters.
fn truncate(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    format!("{}\n\n[content truncated]", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn test_truncate_short_text() {
        let text = "hello world";
        assert_eq!(truncate(text, 100), "hello world");
    }

    #[test]
    fn test_truncate_long_text() {
        let text = "a".repeat(200);
        let result = truncate(&text, 50);
        assert!(result.starts_with(&"a".repeat(50)));
        assert!(result.ends_with("[content truncated]"));
    }

    #[test]
    fn test_truncate_exact_boundary() {
        let text = "abcde";
        assert_eq!(truncate(text, 5), "abcde");
    }

    #[test]
    fn test_truncate_multibyte() {
        // Each emoji is 4 bytes
        let text = "😀😀😀";
        let result = truncate(text, 5);
        // Should truncate to the char boundary at 4 (one emoji)
        assert!(result.starts_with("😀"));
        assert!(result.ends_with("[content truncated]"));
    }

    // ── Domain whitelist tests ──────────────────────────────────────

    #[tokio::test]
    async fn test_empty_whitelist_allows_all_domains() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/page"))
            .respond_with(ResponseTemplate::new(200).set_body_string("allowed"))
            .mount(&server)
            .await;

        let client = Client::new();
        let url = format!("{}/page", server.uri());
        let result = fetch_url(&client, &url, &[]).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "allowed");
    }

    #[tokio::test]
    async fn test_whitelisted_domain_allowed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;

        let client = Client::new();
        let url = server.uri();
        // The mock server runs on 127.0.0.1, so whitelist that.
        let allowed = vec!["127.0.0.1".to_string()];
        let result = fetch_url(&client, &url, &allowed).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_non_whitelisted_domain_rejected() {
        let client = Client::new();
        let allowed = vec!["example.com".to_string()];
        let result = fetch_url(&client, "https://evil.org/page", &allowed).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("not in the allowed list"));
    }

    #[tokio::test]
    async fn test_subdomain_matching() {
        let client = Client::new();
        let allowed = vec!["example.com".to_string()];
        // sub.example.com should match because it ends with ".example.com"
        // This will fail on the network request, but the domain check should pass.
        // We verify by checking that the error is NOT about the whitelist.
        let result = fetch_url(&client, "https://sub.example.com/page", &allowed).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            !err.contains("not in the allowed list"),
            "subdomain sub.example.com should be allowed by whitelist for example.com"
        );
    }

    #[tokio::test]
    async fn test_subdomain_not_matching_different_base() {
        let client = Client::new();
        let allowed = vec!["example.com".to_string()];
        let result = fetch_url(&client, "https://notexample.com/page", &allowed).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("not in the allowed list"));
    }

    #[tokio::test]
    async fn test_invalid_url() {
        let client = Client::new();
        let result = fetch_url(&client, "not a url", &[]).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("invalid URL"));
    }

    #[tokio::test]
    async fn test_http_404_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/missing"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let client = Client::new();
        let url = format!("{}/missing", server.uri());
        let result = fetch_url(&client, &url, &[]).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("404"));
    }

    #[tokio::test]
    async fn test_http_500_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/error"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let client = Client::new();
        let url = format!("{}/error", server.uri());
        let result = fetch_url(&client, &url, &[]).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("500"));
    }

    #[tokio::test]
    async fn test_html_to_text_conversion() {
        let server = MockServer::start().await;
        let html = "<html><body><h1>Title</h1><p>Hello world</p></body></html>";
        Mock::given(method("GET"))
            .and(path("/page"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(html, "text/html; charset=utf-8"))
            .mount(&server)
            .await;

        let client = Client::new();
        let url = format!("{}/page", server.uri());
        let result = fetch_url(&client, &url, &[]).await.unwrap();
        assert!(result.contains("Title"));
        assert!(result.contains("Hello world"));
        // Should not contain raw HTML tags
        assert!(!result.contains("<h1>"));
        assert!(!result.contains("<p>"));
    }

    #[tokio::test]
    async fn test_plain_text_passthrough() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/data"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("Content-Type", "text/plain")
                    .set_body_string("raw text data"),
            )
            .mount(&server)
            .await;

        let client = Client::new();
        let url = format!("{}/data", server.uri());
        let result = fetch_url(&client, &url, &[]).await.unwrap();
        assert_eq!(result, "raw text data");
    }

    #[tokio::test]
    async fn test_url_with_no_host() {
        let client = Client::new();
        let result = fetch_url(&client, "data:text/plain,hello", &[]).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("no host"));
    }

    #[tokio::test]
    async fn test_redirect_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/redir"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("Location", "http://evil.internal/secret"),
            )
            .mount(&server)
            .await;

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let url = format!("{}/redir", server.uri());
        let result = fetch_url(&client, &url, &[]).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("redirect"));
        assert!(err.contains("evil.internal"));
    }
}
