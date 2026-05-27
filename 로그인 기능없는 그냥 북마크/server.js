// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const TABLE_NAME = process.env.SUPABASE_BOOKMARKS_TABLE || 'bookmarks';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.warn('Supabase 환경변수가 설정되지 않았습니다. SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY를 설정해주세요.');
}

const supabase = supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

// 미들웨어 설정
app.use(cors());
app.use(express.json());

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

function ensureSupabase(res) {
    if (supabase) return true;
    res.status(500).json({ error: 'Supabase 환경변수가 설정되지 않았습니다.' });
    return false;
}

function toClientBookmark(row) {
    return {
        id: row.id,
        title: row.title,
        url: row.url,
        thumbnailUrl: row.thumbnail_url
    };
}

// 1. 북마크 전체 목록 불러오기 API
app.get('/api/bookmarks', async (req, res) => {
    if (!ensureSupabase(res)) return;

    try {
        const { data, error } = await supabase
            .from(TABLE_NAME)
            .select('id, title, url, thumbnail_url, created_at')
            .order('created_at', { ascending: true });

        if (error) throw error;
        res.json((data || []).map(toClientBookmark));
    } catch (err) {
        console.error('Supabase 목록 조회 실패:', err.message);
        res.status(500).json({ error: '데이터베이스에서 북마크를 읽어오는 중 오류가 발생했습니다.' });
    }
});

// 2. 북마크 추가 및 메타데이터 크롤링 API
app.post('/api/bookmarks', async (req, res) => {
    let { url, customName } = req.body;
    if (!url) return res.status(400).json({ error: 'URL 주소가 필요합니다.' });

    // 프로토콜 자동 보완
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }

    let finalTitle = customName || '불러오는 중...';
    let finalImg = 'https://via.placeholder.com/300x180?text=No+Image';
    const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');

    // [유튜브] 고화질 썸네일 변환
    if (isYoutube) {
        let videoId = '';
        if (url.includes('watch?v=')) {
            videoId = url.split('v=')[1]?.split('&')[0];
        } else if (url.includes('youtu.be/')) {
            videoId = url.split('youtu.be/')[1]?.split('?')[0];
        } else {
            videoId = url.split('/').pop()?.split('?')[0];
        }
        if (videoId) {
            finalImg = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        }
    }

    // [크롤링 지점] 이름 자동 추출 시 내부 서버 크롤링 진행
    try {
        if (!customName && isYoutube) {
            // 유튜브 공식 Noembed API 호출
            const ytRes = await axios.get(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
            if (ytRes.data && ytRes.data.title) {
                finalTitle = ytRes.data.title;
            }
        } else if (!customName && !isYoutube) {
            // 일반 웹사이트 cheerio 크롤링
            const response = await axios.get(url, { 
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                timeout: 4000 
            });
            const $ = cheerio.load(response.data);
            
            const ogTitle = $('meta[property="og:title"]').attr('content');
            const titleTag = $('title').text();
            finalTitle = ogTitle || titleTag || '새 북마크 링크';

            const ogImg = $('meta[property="og:image"]').attr('content');
            if (ogImg) {
                finalImg = ogImg;
            } else {
                let iconHref = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href');
                if (iconHref && !iconHref.startsWith('http')) {
                    const originUrl = new URL(url);
                    iconHref = originUrl.origin + (iconHref.startsWith('/') ? '' : '/') + iconHref;
                }
                if (iconHref) finalImg = iconHref;
            }
        }
    } catch (err) {
        console.error(`크롤링 실패 (${url}):`, err.message);
        if (!customName) finalTitle = '디자인 레퍼런스 페이지';
    }

    if (!finalTitle || finalTitle === '불러오는 중...') {
        finalTitle = customName || '새로운 디자인 레퍼런스';
    }

    // Supabase에 최종 저장 //
    try {
        if (!ensureSupabase(res)) return;

        const newBookmark = {
            id: Date.now().toString(),
            title: finalTitle.trim(),
            url: url,
            thumbnail_url: finalImg
        };

        const { data, error } = await supabase
            .from(TABLE_NAME)
            .insert(newBookmark)
            .select('id, title, url, thumbnail_url')
            .single();

        if (error) throw error;
        res.json(toClientBookmark(data));
    } catch (err) {
        console.error('Supabase 저장 실패:', err.message);
        res.status(500).json({ error: '데이터베이스 저장 중 오류가 발생했습니다.' });
    }
});

// 3. 북마크 개별 삭제 API
app.delete('/api/bookmarks/:id', async (req, res) => {
    if (!ensureSupabase(res)) return;

    const { id } = req.params;
    try {
        const { error } = await supabase
            .from(TABLE_NAME)
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('Supabase 삭제 실패:', err.message);
        res.status(500).json({ error: '데이터베이스 삭제 중 오류가 발생했습니다.' });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`서버가 성공적으로 가동되었습니다: http://localhost:${PORT}`);
    });
}

module.exports = app;
