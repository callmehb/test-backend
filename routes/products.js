const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const productController = require('../controllers/productController');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'Uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    },
});
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (!file) {
            return cb(null, false); // Skip if no file provided
        }
        const filetypes = /jpeg|jpg|png|webp/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        }
        cb('Error: Images only (jpeg, jpg, png, webp)!');
    },
});

router.get('/', productController.getAllProducts);
router.get('/:id', productController.getSingleProduct);
router.post('/', upload.array('images', 5), productController.createProduct);
router.put('/:id', upload.array('images', 5), productController.updateProduct);
router.delete('/delete-multiple', productController.deleteManyProducts);
router.post('/deduct-many', productController.deductManyProducts);
router.delete('/:id/image/:imageName', productController.deleteProductImage);

module.exports = router;
