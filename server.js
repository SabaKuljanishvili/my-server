require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
const multer = require('multer')

const app = express()

// Enable CORS and JSON parsing
app.use(cors())
app.use(express.json())

// Configure Multer for file uploads (storing in memory for Supabase)
const upload = multer({ storage: multer.memoryStorage() })

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ================= AUTH =================

app.post('/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    })

    if (authError) throw authError

    // Determine role robustly:
    // 1) Try profiles table by user id
    // 2) Fallback to user/app metadata
    // 3) If no profiles exist (first user) or specific admin email, upsert admin
    let role = 'user'
    try {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', authData.user.id)
        .single()

      if (!profileError && profile && profile.role) {
        role = profile.role
      } else if (authData.user.user_metadata && authData.user.user_metadata.role) {
        role = authData.user.user_metadata.role
      } else if (authData.user.app_metadata && authData.user.app_metadata.role) {
        role = authData.user.app_metadata.role
      } else {
        // If no profile row exists, check if the profiles table is empty -> make this account admin
        try {
          const { data: someProfiles } = await supabase
            .from('profiles')
            .select('id')
            .limit(1)

          const noProfilesExist = !someProfiles || someProfiles.length === 0
          if (noProfilesExist || email === 'admin@lego.com') {
            // Upsert an admin profile for this user (service key allows this)
            await supabase.from('profiles').upsert({ id: authData.user.id, role: 'admin' })
            role = 'admin'
          }
        } catch (innerErr) {
          console.warn('Could not inspect/upsert profiles table:', innerErr.message)
        }
      }
    } catch (err) {
      console.warn('Profile fetch failed, using fallback role check.')
    }

    res.json({
      ...authData,
      user: { ...authData.user, role },
      token: authData.session && authData.session.access_token ? authData.session.access_token : null
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(400).json({ error: error.message })
  }
})

// ================= PRODUCTS =================

// Get all products with category names (flattened for frontend)
app.get('/products', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*, categories(name)')
      .order('created_at', { ascending: false })

    if (error) throw error

    // Flatten the response for the frontend
    const flattenedData = data.map(p => {
      let category_name = 'LEGO'
      if (p.categories) {
        category_name = Array.isArray(p.categories) ? p.categories[0]?.name || 'LEGO' : p.categories.name || 'LEGO'
      }
      return { ...p, category_name }
    })

    res.json(flattenedData)
  } catch (error) {
    console.error('Get products error:', error)
    res.status(400).json({ error: error.message })
  }
})

// Get single product with details and additional images
app.get('/products/:id', async (req, res) => {
  const { id } = req.params
  try {
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('*, categories(name)')
      .eq('id', id)
      .single()

    if (productError) throw productError

    // Also fetch associated images from 'product_images' table
    const { data: images, error: imageError } = await supabase
      .from('product_images')
      .select('image_url')
      .eq('product_id', id)

    res.json({
      ...product,
      category_name: product.categories ? (Array.isArray(product.categories) ? product.categories[0]?.name || 'LEGO' : product.categories.name || 'LEGO') : 'LEGO',
      product_images: images || []
    })
  } catch (error) {
    res.status(404).json({ error: error.message })
  }
})

// Add/Update Product (Handles multipart/form-data)
app.post('/products', upload.fields([
  { name: 'main_image', maxCount: 1 },
  { name: 'extra_images', maxCount: 10 }
]), async (req, res) => {
  try {
    const productData = req.body
    let mainImageUrl = productData.main_image || ''

    // 1. Upload Main Image to Supabase Storage if present
    if (req.files['main_image']) {
      const file = req.files['main_image'][0]
      const path = `products/${Date.now()}-${file.originalname}`
      const { data, error } = await supabase.storage.from('products').upload(path, file.buffer, {
        contentType: file.mimetype
      })
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('products').getPublicUrl(path)
      mainImageUrl = publicUrl
    }

    // 2. Insert/Update Product in DB
    const { data: newProduct, error: prodError } = await supabase
      .from('products')
      .insert([{
        title: productData.title,
        short_description: productData.short_description,
        large_description: productData.large_description,
        price: parseFloat(productData.price),
        discount_price: productData.discount_price ? parseFloat(productData.discount_price) : null,
        category_id: productData.category_id,
        discount_start: productData.discount_start || null,
        discount_end: productData.discount_end || null,
        main_image: mainImageUrl
      }])
      .select()
      .single()

    if (prodError) throw prodError

    // 3. Upload Extra Images
    if (req.files['extra_images']) {
      for (const file of req.files['extra_images']) {
        const path = `products/${Date.now()}-${file.originalname}`
        const { error: uploadError } = await supabase.storage.from('products').upload(path, file.buffer, {
          contentType: file.mimetype
        })
        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage.from('products').getPublicUrl(path)
          await supabase.from('product_images').insert([{
            product_id: newProduct.id,
            image_url: publicUrl
          }])
        }
      }
    }

    res.json(newProduct)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Patch Product
app.patch('/products/:id', upload.fields([
  { name: 'main_image', maxCount: 1 },
  { name: 'extra_images', maxCount: 10 }
]), async (req, res) => {
  try {
    const productId = req.params.id
    // Fetch existing product to know current main_image
    const { data: existingProduct } = await supabase
      .from('products')
      .select('main_image')
      .eq('id', productId)
      .single()
    const productData = req.body
    let updateData = {
      title: productData.title,
      short_description: productData.short_description,
      large_description: productData.large_description,
      price: parseFloat(productData.price),
      discount_price: productData.discount_price ? parseFloat(productData.discount_price) : null,
      category_id: productData.category_id,
      discount_start: productData.discount_start || null,
      discount_end: productData.discount_end || null,
    }

    if (req.files['main_image']) {
      const file = req.files['main_image'][0]
      const path = `products/${Date.now()}-${file.originalname}`
      const { error } = await supabase.storage.from('products').upload(path, file.buffer, {
        contentType: fil0e.mimetype
      })
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('products').getPublicUrl(path)
      updateData.main_image = publicUrl

      // After successful upload, remove the old main image from storage (if present and different)
      try {
        const oldUrl = existingProduct && existingProduct.main_image
        if (oldUrl && oldUrl !== publicUrl && oldUrl.includes('/products/')) {
          const oldPath = oldUrl.split('/products/')[1]
          if (oldPath) {
            const { error: storageDelErr } = await supabase.storage.from('products').remove([`products/${oldPath}`])
            if (storageDelErr) console.error('Error deleting old main image from storage:', storageDelErr)
          }
        }
      } catch (e) {
        console.error('Failed to delete old main image:', e)
      }
    }

    const { data: updatedProduct, error: prodError } = await supabase
      .from('products')
      .update(updateData)
      .eq('id', productId)
      .select()
      .single()

    if (prodError) throw prodError

    // 3. Handle Deleting Existing Images
    if (productData.delete_images) {
      try {
        const urlsToDelete = Array.isArray(productData.delete_images)
          ? productData.delete_images
          : JSON.parse(productData.delete_images)

        if (Array.isArray(urlsToDelete) && urlsToDelete.length > 0) {
          // Delete files from Supabase storage (if they exist)
          for (const url of urlsToDelete) {
            // აქ ვიღებთ path-ს publicUrl-დან
            const path = url.split('/products/')[1]
            if (path) {
              const { error: storageErr } = await supabase.storage.from('products').remove([`products/${path}`])
              if (storageErr) console.error('Error deleting from storage:', storageErr)
            }
          }

          // Delete records from product_images table
          const { error: delErr } = await supabase
            .from('product_images')
            .delete()
            .eq('product_id', productId)
            .in('image_url', urlsToDelete)

          if (delErr) console.error('Supabase delete error:', delErr)
        }
      } catch (e) {
        console.error('Error deleting images:', e)
      }
    }

    if (req.files['extra_images']) {
      for (const file of req.files['extra_images']) {
        const path = `products/${Date.now()}-${file.originalname}`
        const { error: uploadError } = await supabase.storage.from('products').upload(path, file.buffer, {
          contentType: file.mimetype
        })
        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage.from('products').getPublicUrl(path)
          await supabase.from('product_images').insert([{
            product_id: productId,
            image_url: publicUrl
          }])
        }
      }
    }

    res.json(updatedProduct)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Delete Product
app.delete('/products/:id', async (req, res) => {
  const productId = req.params.id
  try {
    // 1. Fetch associated image URLs so we can remove files from storage
    const { data: images } = await supabase
      .from('product_images')
      .select('image_url')
      .eq('product_id', productId)

    const { data: product } = await supabase
      .from('products')
      .select('main_image')
      .eq('id', productId)
      .single()

    // 2. Remove files from storage for extra images
    if (images && images.length > 0) {
      for (const row of images) {
        const url = row.image_url
        if (url && url.includes('/products/')) {
          const path = url.split('/products/')[1]
          if (path) {
            const { error: storageErr } = await supabase.storage.from('products').remove([`products/${path}`])
            if (storageErr) console.error('Error deleting from storage:', storageErr)
          }
        }
      }
    }

    // 3. Remove main image from storage
    if (product && product.main_image && product.main_image.includes('/products/')) {
      const mainPath = product.main_image.split('/products/')[1]
      if (mainPath) {
        const { error: mainDelErr } = await supabase.storage.from('products').remove([`products/${mainPath}`])
        if (mainDelErr) console.error('Error deleting main image from storage:', mainDelErr)
      }
    }

    // 4. Delete associated product_images records
    const { error: delImagesErr } = await supabase.from('product_images').delete().eq('product_id', productId)
    if (delImagesErr) console.error('Error deleting product_images rows:', delImagesErr)

    // 5. Delete the product
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', productId)

    if (error) throw error
    res.json({ message: 'Deleted successfully' })
  } catch (error) {
    console.error('Delete product error:', error)
    res.status(400).json({ error: error.message })
  }
})

// ================= CATEGORIES =================

app.get('/categories', async (req, res) => {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('name')

  if (error) return res.status(400).json({ error: error.message })
  res.json(data)
})

app.post('/categories', async (req, res) => {
  const { name } = req.body
  const { data, error } = await supabase
    .from('categories')
    .insert([{ name }])
    .select()
    .single()

  if (error) return res.status(400).json({ error: error.message })
  res.json(data)
})

app.delete('/categories/:id', async (req, res) => {
  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('id', req.params.id)

  if (error) return res.status(400).json({ error: error.message })
  res.json({ message: 'Category deleted' })
})

// ================= SERVER =================

// Use env PORT, fallback to 3000 for local development only
const PORT = process.env.PORT || 3000   // 3000 არის fallback მხოლოდ ლოკალისთვის
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://my-server-1-h2hb.onrender.com'

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
  console.log(`Public URL (if hosted): ${PUBLIC_URL}`)
})